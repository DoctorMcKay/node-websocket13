import ByteBuffer from 'bytebuffer';
import {randomBytes} from 'crypto';
import {EventEmitter} from 'events';
import PermessageDeflate from 'permessage-deflate';
import WebSocketExtensions from 'websocket-extensions';

import StreamedIncomingMessage from './streams/StreamedIncomingMessage';
import StreamedOutgoingMessage from './streams/StreamedOutgoingMessage';

import State from './enums/State';
import {WebSocketStats, BaseWebSocketOptions, WsFrame, WsExtensionFrame, WsExtensionMessage} from './interfaces-internal';
import {Socket} from 'net';
import {TLSSocket} from 'tls';
import StatusCode from './enums/StatusCode';
import Timer = NodeJS.Timer;
import FrameType from './enums/FrameType';

export default class WebSocketBase extends EventEmitter {
	state: State;
	protocol?: string;
	stats: WebSocketStats;
	options: BaseWebSocketOptions;
	remoteAddress: string;

	_socket: Socket|TLSSocket;
	_extensions: WebSocketExtensions;
	_data: object;
	_outgoingFrames: any; // todo
	_dataBuffer: Buffer;
	_incomingStream: any; // StreamedIncomingFrame; todo
	_extensionProcessingOutgoingFrameId: number;
	_pingFailures: number;
	_userTimeout?: Timer;
	_userTimeoutMs?: number;
	_pingCallbacks: object;
	_pingTimer: Timer;        // When elapsed, sends a ping frame
	_pingTimeout: Timer;      // When elapsed, considers a ping to have timed out if no pong has been received
	_type: string;            // 'server' if we're a server, or 'client' if we're a client socket

	constructor() {
		super();

		this.state = State.Closed;
		this._extensions = new WebSocketExtensions();
		this._extensions.add(PermessageDeflate);
		this.protocol = null;
		this.stats = {tx: {wire: 0, preExt: 0}, rx: {wire: 0, postExt: 0}};

		this.options = {
			pingInterval: 10000,
			pingTimeout: 10000,
			pingFailures: 3
		};

		this._data = {};
		this._outgoingFrames = []; // holds frame objects which we haven't sent yet
		this._dataBuffer = Buffer.alloc(0); // holds raw TCP data that we haven't processed yet
		this._incomingStream = null; // StreamedIncomingMessage object for the current message
		this._extensionProcessingOutgoingFrameId = 0;

		this.on('connected', () => {
			this._pingFailures = 0;
			this._queuePing();
		});
	}

	/**
	 * Disconnect the websocket gracefully.
	 * @param {number} [code=StatusCode.NormalClosure] - A value from the StatusCode enum to send to the other side
	 * @param {string} [reason] - An optional reason string to send to the other side
	 */
	disconnect(code?: number, reason?: string): void {
		if (this.state == State.Connecting && this._socket) {
			this._socket.end();
			// @ts-ignore
			this._socket.destroy();
			this.state = State.Closed;
		} else if (this.state == State.Connecting && !this._socket) {
			this.state = State.Closing;
		} else if (this.state == State.Connected) {
			code = code || StatusCode.NormalClosure;
			reason = reason || '';

			let buf = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
			buf.writeUint16(code);
			buf.writeString(reason);

			this._sendControl(FrameType.Control.Close, buf.flip().toBuffer());
			this._outgoingFrames = []; // empty the queue; we can't send any more data now
			this.state = State.Closing;

			setTimeout(() => {
				if (this.state != State.Closed) {
					this._closeExtensions(() => {
						this._socket.end();
					});
				}
			}, 5000).unref();
		} else {
			throw new Error('Cannot disconnect a WebSocket that is not connected.');
		}
	}

	/**
	 * Send some data in a single frame (not streamed).
	 * @param {string|Buffer} data - The data to send. If a string, the data will be sent as UTF-8 text. If a Buffer, it will be sent as binary data.
	 */
	send(data): void {
		let opcode = (typeof data === 'string' ? FrameType.Data.Text : FrameType.Data.Binary);
		if (ByteBuffer.isByteBuffer(data)) {
			data = data.toBuffer();
		} else if (typeof data === 'string') {
			data = Buffer.from(data, 'utf8');
		}

		this._sendFrame({
			FIN: true,
			RSV1: false,
			RSV2: false,
			RSV3: false,
			opcode,
			payloadLength: data.length,
			payload: data
		});
	}

	createMessageStream(type): StreamedOutgoingMessage {
		let frame = new StreamedOutgoingMessage(this, type);
		this._outgoingFrames.push(frame);
		return frame;
	}

	data(key: string, value: any): any {
		let val = this._data[key];

		if (typeof value === 'undefined') {
			return val;
		}

		this._data[key] = value;
		return val;
	}

	getPeerCertificate(detailed?: boolean) {
		if (!(this._socket instanceof TLSSocket)) {
			return null;
		}

		let socket:TLSSocket = this._socket as TLSSocket;
		return socket.getPeerCertificate(detailed);
	}

	getSecurityProtocol() {
		if (!(this._socket instanceof TLSSocket)) {
			return null;
		}

		let socket:TLSSocket = this._socket as TLSSocket;
		// @ts-ignore
		return socket.getProtocol();
	}

	_prepSocketEvents() {
		this.remoteAddress = this._socket.remoteAddress;

		this._socket.on('data', (data) => {
			if ([State.Connected, State.Closing, State.ClosingError].includes(this.state)) {
				this._handleData(data);
			}
		});

		this._socket.on('close', () => {
			this._cleanupTimers();

			if (this.state == State.ClosingError) {
				this.state = State.Closed;
				return;
			}

			if (this.state == State.Closed) {
				this.emit('debug', 'Socket closed after successful websocket closure.');
				return;
			}

			let state = this.state;
			this.state = State.Closed;
			this.emit('disconnected', StatusCode.AbnormalTermination, 'Socket closed', state == State.Closing);
			this._closeExtensions();
			this._cleanupTimers();
		});

		this._socket.on('error', (err) => {
			if (this.state == State.Closed || this.state == State.ClosingError) {
				// Ignore errors that come after the socket is closed (e.g. ECONNRESET when we respond to Close frames)
				return;
			}

			err.state = this.state;
			this.state = State.ClosingError;
			this._closeExtensions();
			this._cleanupTimers();
			this.emit('error', err);
		});
	}

	setTimeout(timeout: number, callback?: () => void) {
		if (this._userTimeout) {
			clearTimeout(this._userTimeout);
		}

		delete this._userTimeout;
		delete this._userTimeoutMs;

		if (timeout == 0) {
			return this;
		}

		this._userTimeoutMs = timeout;
		this._resetUserTimeout();

		if (typeof callback === 'function') {
			this.once('timeout', callback);
		}
	}

	_resetUserTimeout(): void {
		if (this._userTimeout) {
			clearTimeout(this._userTimeout);
			delete this._userTimeout;
		}

		if (this._userTimeoutMs) {
			this._userTimeout = setTimeout(() => {
				delete this._userTimeout;
				this.setTimeout(0); // don't keep triggering timeout
				this.emit('timeout');
			}, this._userTimeoutMs);
		}
	}

	sendPing(callback: () => void) {
		this._pingCallbacks = this._pingCallbacks || {};
		let pingData:Buffer, pingNum:number;

		do {
			pingData = randomBytes(4);
			pingNum = pingData.readUInt32BE(0);
		} while (this._pingCallbacks[pingNum]);

		// eslint-disable-next-line
		this._pingCallbacks[pingNum] = callback || function() {};

		this._sendFrame({
			FIN: true,
			RSV1: false,
			RSV2: false,
			RSV3: false,
			opcode: FrameType.Control.Ping,
			payloadLength: pingData.length,
			payload: pingData
		}, true);
	}

	_queuePing() {
		clearTimeout(this._pingTimer);
		clearTimeout(this._pingTimeout);

		if (this.state != State.Connected || !this.options.pingInterval || !this.options.pingTimeout || !this.options.pingFailures) {
			return;
		}

		this._pingTimer = setTimeout(() => {
			if (this.state != State.Connected) {
				return;
			}

			let time = Date.now();
			this.sendPing(() => {
				this.emit('latency', Date.now() - time);
				this._pingFailures = 0;
				this._queuePing();
			});

			this._pingTimeout = setTimeout(() => {
				if (this.state != State.Connected) {
					return;
				}

				this.emit('debug', `Ping timeout #${this._pingFailures + 1}`);

				if (++this._pingFailures >= this.options.pingFailures) {
					this._terminateError(StatusCode.PolicyViolation, 'Ping timeout');
				} else {
					this._queuePing();
				}
			}, this.options.pingTimeout);
		}, this.options.pingInterval);
	}

	_handleData(data?: Buffer) {
		if (data && data.length > 0) {
			this._dataBuffer = Buffer.concat([this._dataBuffer, data]);
			this._queuePing(); // reset the ping timer
		}

		if (this._dataBuffer.length == 0) {
			return;
		}

		let buf = ByteBuffer.wrap(this._dataBuffer, ByteBuffer.BIG_ENDIAN);
		let frame:WsFrame = null;

		try {
			let byte = buf.readUint8();
			let fin = !!(byte & (1 << 7));
			let rsv1 = !!(byte & (1 << 6));
			let rsv2 = !!(byte & (1 << 5));
			let rsv3 = !!(byte & (1 << 4));
			let opcode = byte & 0x0F;

			byte = buf.readUint8();
			let hasMask = !!(byte & (1 << 7));
			let payloadLength = byte & 0x7F;

			if (payloadLength == 126) {
				payloadLength = buf.readUint16();
			} else if (payloadLength == 127) {
				payloadLength = parseInt(buf.readUint64(), 10);
			}

			let maskKey = null;
			if (hasMask) {
				maskKey = buf.readUint32();
			}

			if (buf.remaining() < payloadLength) {
				return; // We don't have the entire payload yet
			}

			let payload = buf.slice(buf.offset, buf.offset + payloadLength).toBuffer();
			buf.skip(payloadLength);

			// got the full frame
			frame = {
				FIN: fin,
				RSV1: rsv1,
				RSV2: rsv2,
				RSV3: rsv3,
				opcode,
				payloadLength,
				maskKey,
				payload
			};
		} catch (ex) {
			// We don't have the full data yet. No worries.
			return;
		}

		// We have a full frame
		this._dataBuffer = buf.toBuffer();
		this._handleFrame(frame);

		this._handleData();
	}

	_handleFrame(frame: WsFrame) {
		// Flags: FIN, RSV1, RSV2, RSV3
		// Ints: opcode (4 bits), payloadLength (up to 64 bits), maskKey (32 bits)
		// Binary: payload

		let overheadLength = getFrameOverheadLength(frame);
		this.stats.rx.wire += overheadLength + frame.payload.length;
		this.stats.rx.postExt += overheadLength; // extensions can't change overhead length

		let debugMsg = `Got frame ${frame.opcode.toString(16).toUpperCase()}, ${frame.FIN ? 'FIN, ' : ''}`;
		for (let i = 1; i <= 3; i++) {
			if (frame['RSV' + i]) {
				debugMsg += `RSV${i}, `;
			}
		}

		debugMsg += (frame.maskKey ? 'MASK, ' : '') + `payload ${frame.payload.length} bytes`;

		this.emit('debug', debugMsg);

		if (
			this.state != State.Connected &&
			!(
				(this.state == State.ClosingError || this.state == State.Closing) &&
				frame.opcode == FrameType.Control.Close
			)
		) {
			this.emit('debug', `Got frame ${frame.opcode.toString(16)} while in state ${this.state}`);
			return;
		}

		// The RFC requires us to terminate the connection if we get an unmasked frame from a client or a masked frame from
		// a server. But in the real world, implementations are bad sometimes so for compatibility's sake, just log it.
		if (
			(this._type == 'server' && !frame.maskKey && frame.payload.length > 0) ||
			(this._type == 'client' && frame.maskKey)
		) {
			this.emit('debug', `Protocol violation: Received ${frame.maskKey ? 'masked' : 'unmasked'} frame ` +
				`${frame.opcode.toString(16).toUpperCase()} of length ${frame.payload.length} from ${this._type == 'client' ? 'server' : 'client'}`);
		}

		// Unmask if applicable
		if (frame.maskKey !== null && frame.payload && frame.payload.length > 0) {
			frame.payload = maskOrUnmask(frame.payload, frame.maskKey);
		}

		// Check to make sure RSV bits are valid
		if (this._extensions && !this._extensions.validFrameRsv(getExtensionFrame(frame))) {
			this._terminateError(StatusCode.ProtocolError, 'Unexpected reserved bit set');
			return;
		}

		let payload;

		// Is this a control frame? They need to be handled before anything else as they can be interjected between
		// fragmented message frames.
		if (frame.opcode & (1 << 3)) {
			// this is a control frame.

			if (!frame.FIN) {
				this._terminateError(StatusCode.ProtocolError, `Got a fragmented control frame ${frame.opcode.toString(16)}`);
				return;
			}

			if (frame.payload.length > 125) {
				this._terminateError(StatusCode.ProtocolError, `Got a control frame ${frame.opcode.toString(16)} with invalid payload length ${frame.payload.length}`);
				return;
			}

			// Run it through extensions
			this._extensions.processIncomingMessage(getExtensionMessage(frame), (err, msg) => {
				if (err) {
					this._terminateError(StatusCode.ProtocolError, err.message || err);
					return;
				}

				frame = fromExtensionMessage(msg);
				this.stats.rx.postExt += frame.payload.length;

				switch (frame.opcode) {
					case FrameType.Control.Close:
						let code = StatusCode.NoStatusCode;
						let reason = '';

						if (frame.payload && frame.payload.length >= 2) {
							code = frame.payload.readUInt16BE(0);

							if (frame.payload.length > 2) {
								reason = frame.payload.toString('utf8', 2);
							}
						}

						let state = this.state;

						if (state == State.Closing || state == State.ClosingError) {
							this._cleanupTimers();
							this._closeExtensions(() => {
								this._socket.end();
							});

							// We're all done here
						} else {
							if (code != StatusCode.NoStatusCode) {
								payload = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
								payload.writeUint16(code);
								payload.writeString(reason || '');
							} else {
								payload = new ByteBuffer(0, ByteBuffer.BIG_ENDIAN); // don't send anything back
							}

							this._sendControl(FrameType.Control.Close, payload.flip().toBuffer());
							this._cleanupTimers();
							this._closeExtensions(() => {
								this._socket.end();
							});
						}

						this.state = State.Closed;

						if (state != State.ClosingError) {
							this.emit('disconnected', code, reason, state == State.Closing);
						}

						break;

					case FrameType.Control.Ping:
						this._sendControl(FrameType.Control.Pong, frame.payload);
						break;

					case FrameType.Control.Pong:
						if (frame.payload && frame.payload.length == 4) {
							let num = frame.payload.readUInt32BE(0);
							if (this._pingCallbacks[num]) {
								this._pingCallbacks[num]();
								delete this._pingCallbacks[num];
							}
						}

						break;

					default:
						this._terminateError(StatusCode.UnacceptableDataType, `Unknown control frame type ${frame.opcode.toString(16).toUpperCase()}`);
				}
			});

			return;
		}

		// Sanity checks
		if (!this._incomingStream && frame.opcode == FrameType.Continuation) {
			this._terminateError(StatusCode.ProtocolError, 'Received continuation frame without initial frame.');
			return;
		} else if (this._incomingStream && frame.opcode != FrameType.Continuation) {
			this._terminateError(StatusCode.ProtocolError, 'Received new message without finishing a fragmented one.');
			return;
		}

		// this is not a control frame.
		this._resetUserTimeout();

		// Is this the first frame of a fragmented message?
		if (!frame.FIN && !this._incomingStream) {
			this.emit('debug', 'Got first frame of fragmented message.');

			let dispatch = this.listenerCount('streamedMessage') >= 1 && !frame.RSV1 && !frame.RSV2 && !frame.RSV3;
			this._incomingStream = new StreamedIncomingMessage(frame, dispatch);

			if (dispatch) {
				this.emit('streamedMessage', frame.opcode, this._incomingStream);
			}

			this._incomingStream.on('end', data => {
				if (!dispatch) {
					let frame = this._incomingStream.frameHeader;
					frame.payload = data;
					frame.payloadLength = frame.payload.length;

					this._dispatchDataFrame(frame);
				}
			});

			// record this start frame in stats only if we've dispatched the stream. if we haven't, we'll process the whole
			// message as one.
			if (dispatch) {
				this.stats.rx.postExt += frame.payload.length;
			}

			return;
		}

		if (frame.opcode == FrameType.Continuation) {
			this.emit('debug', 'Got continuation frame');
			this._incomingStream._frame(frame);

			// record this frame in stats only if we've dispatched the stream. if we haven't, we'll process the whole
			// message as one.
			if (this._incomingStream._dispatched) {
				this.stats.rx.postExt += frame.payload.length;
			}

			if (frame.FIN) {
				this._incomingStream = null;
			}

			return;
		}

		// We know that we have this entire frame now. Let's handle it.
		this._dispatchDataFrame(frame);
	}

	_dispatchDataFrame(frame: WsFrame) {
		this._extensions.processIncomingMessage(getExtensionMessage(frame), (err, msg) => {
			if (err) {
				this._terminateError(StatusCode.ProtocolError, err.message || err);
				return;
			}

			frame = fromExtensionMessage(msg);
			this.stats.rx.postExt += frame.payload.length;

			switch (frame.opcode) {
				case FrameType.Data.Text:
					let utf8 = frame.payload.toString('utf8');

					// Check that the UTF-8 is valid
					if (Buffer.compare(Buffer.from(utf8, 'utf8'), frame.payload) !== 0) {
						// This is invalid. We must tear down the connection.
						this._terminateError(StatusCode.InconsistentData, 'Received invalid UTF-8 data in a text frame.');
						return;
					}

					this.emit('message', FrameType.Data.Text, utf8);
					break;

				case FrameType.Data.Binary:
					this.emit('message', FrameType.Data.Binary, frame.payload);
					break;

				default:
					this._terminateError(StatusCode.UnacceptableDataType, `Unknown data frame type ${frame.opcode.toString(16).toUpperCase()}`);
			}
		});
	}

	_sendFrame(frame: WsFrame, bypassQueue = false): void {
		// eslint-disable-next-line
		let self = this;
		let isControl = !!(frame.opcode & (1 << 3));

		if (this.state != State.Connected && !(this.state == State.Closing && isControl)) {
			throw new Error(`Cannot send data while not connected (state ${this.state})`);
		}

		if (typeof frame.FIN === 'undefined') {
			frame.FIN = true;
		}

		if (isControl) {
			if (frame.payload && frame.payload.length > 125) {
				throw new Error(`Cannot send control frame ${frame.opcode.toString(16).toUpperCase()} with ${frame.payload.length} bytes of payload data. Payload must be 125 bytes or fewer.`);
			}

			bypassQueue = true; // we can send control messages whenever
		}

		frame.payload = frame.payload || Buffer.alloc(0);
		let maskKey = frame.maskKey;
		let fin = frame.FIN;
		let queueId = null;

		// Calculate how long this frame would be as it stands now
		// All frames are at least 2 bytes; byte 1 is FIN, RSV1-3, opcode; byte 2 is MASK bit, payload length
		let preExtLength = 2 + frame.payload.length;
		if (frame.maskKey) {
			preExtLength += 4; // mask keys are always 4 bytes
		}
		preExtLength += getExtraPayloadLengthFieldSize(frame.payload.length);

		this.stats.tx.preExt += preExtLength;

		if (isControl || !frame.FIN || frame.opcode == 0) {
			// https://github.com/faye/permessage-deflate-node/issues/6
			onExtensionsProcessed(frame);
		} else {
			if (!bypassQueue) {
				queueId = ++this._extensionProcessingOutgoingFrameId;
				this._outgoingFrames.push(queueId);

				// What is queueId? It's a placeholder. We want to retain the order guarantee, but we still need to pass this message
				// to extensions. Those might not call back in order. Consequently, we "reserve the message's place" in the outgoing
				// queue with a number. That array position will be replaced with the actual message when it's ready.

				if (queueId >= 4294967295) {
					// just for fun. this is unlikely to ever really happen. 4294967295 is max uint32 and is totally arbitrary, we can go up to 2^53
					this._extensionProcessingOutgoingFrameId = 0;
				}
			}

			this._extensions.processOutgoingMessage(getExtensionMessage(frame), (err, msg) => {
				if (err) {
					this._terminateError(StatusCode.ProtocolError, err.message || err);
					return;
				}

				frame = fromExtensionMessage(msg);
				frame.maskKey = maskKey;
				frame.FIN = fin;
				onExtensionsProcessed(frame);
			});
		}

		function onExtensionsProcessed(frame) {
			let debugMsg = `${bypassQueue ? 'Sending' : 'Queueing'} frame ${frame.opcode.toString(16).toUpperCase()}, ${frame.FIN ? 'FIN, ' : ''}`;
			for (let i = 1; i <= 3; i++) {
				if (frame['RSV' + i]) {
					debugMsg += `RSV${i}, `;
				}
			}

			debugMsg += (frame.maskKey ? 'MASK, ' : '') + `payload ${frame.payload.length} bytes`;
			self.emit('debug', debugMsg);

			let size = 0;
			size += 1; // FIN, RSV1, RSV2, RSV3, opcode
			size += 1; // MASK, payload length
			size += getExtraPayloadLengthFieldSize(frame.payload.length);

			if (frame.maskKey) {
				size += 4;
			}

			size += frame.payload.length;

			let buf = new ByteBuffer(size, ByteBuffer.BIG_ENDIAN);
			let byte = 0;

			byte |= (frame.FIN ? 1 : 0) << 7;
			byte |= (frame.RSV1 ? 1 : 0) << 6;
			byte |= (frame.RSV2 ? 1 : 0) << 5;
			byte |= (frame.RSV3 ? 1 : 0) << 4;
			byte |= frame.opcode & 0x0F;
			buf.writeUint8(byte);

			byte = 0;
			byte |= (frame.maskKey ? 1 : 0) << 7;

			if (frame.payload.length <= 125) {
				byte |= frame.payload.length;
				buf.writeUint8(byte);
			} else if (frame.payload.length <= 65535) {
				byte |= 126;
				buf.writeUint8(byte);
				buf.writeUint16(frame.payload.length);
			} else {
				byte |= 127;
				buf.writeUint8(byte);
				buf.writeUint64(frame.payload.length);
			}

			if (frame.maskKey) {
				buf.writeUint32(frame.maskKey);
				buf.append(maskOrUnmask(frame.payload, frame.maskKey));
			} else {
				buf.append(frame.payload);
			}

			// we're done building the buffer, so go ahead and convert it to a node Buffer
			buf = buf.flip().toBuffer();
			self.stats.tx.wire += buf.length;

			if (bypassQueue) {
				self._socket.write(buf);
			} else if (queueId) {
				// This already has a placeholder in the queue
				let idx = self._outgoingFrames.indexOf(queueId);
				if (idx == -1) {
					self._outgoingFrames.push(buf);
				} else {
					self._outgoingFrames[idx] = buf;
				}
			} else {
				// No queue placeholder, just stick it in
				self._outgoingFrames.push(buf);
			}

			self._processQueue();
		}
	}

	_processQueue(): void {
		let frames = this._outgoingFrames.slice(0);

		while (frames.length > 0) {
			if (typeof frames[0] === 'number') {
				// This is a placeholder, so we're done
				break;
			}

			if (frames[0] instanceof StreamedOutgoingMessage) {
				if (!frames[0].started) {
					this.emit('debug', 'Starting StreamedOutgoingMessage');
					frames[0]._start();
				}

				if (frames[0].finished) {
					frames.splice(0, 1);
					continue;
				}

				break;
			}

			this._socket.write(frames.splice(0, 1)[0]);
		}

		this._outgoingFrames = frames;
	}

	_sendControl(opcode: number, payload: Buffer) {
		if (this.state == State.Closed || !this._socket) {
			return;
		}

		this._sendFrame({
			opcode,
			payload,
			payloadLength: payload.length,
			FIN: true,
			RSV1: false,
			RSV2: false,
			RSV3: false
		});
	}

	_closeError(err: Error) {
		(err as any).state = this.state;
		this.state = State.Closed;
		this._closeExtensions();
		this._cleanupTimers();

		if (this._socket) {
			this._socket.end();
			// @ts-ignore
			this._socket.destroy();
		}

		this.emit('error', err);
	}

	_terminateError(code?: number, message?: string): void {
		let err:any = new Error(message);
		err.state = this.state;
		err.code = code;
		this.disconnect(code, message);
		this.state = State.ClosingError;
		this.emit('error', err);
	}

	_cleanupTimers(): void {
		clearTimeout(this._pingTimeout);
		clearTimeout(this._pingTimer);
		clearTimeout(this._userTimeout);
	}

	_closeExtensions(callback?: () => void): void {
		// eslint-disable-next-line
		callback = callback || function() { };

		try {
			this._extensions.close(callback);
		} catch (ex) {
			callback();
		}
	}
}

// Util
function maskOrUnmask(data: Buffer, maskKey: number): Buffer {
	let key = Buffer.alloc(4);
	key.writeUInt32BE(maskKey, 0);

	for (let i = 0; i < data.length; i++) {
		data[i] ^= key[i % 4];
	}

	return data;
}

function getExtensionFrame(frame: WsFrame): WsExtensionFrame {
	return {
		final: frame.FIN,
		rsv1: frame.RSV1,
		rsv2: frame.RSV2,
		rsv3: frame.RSV3,
		opcode: frame.opcode,
		masked: !!frame.maskKey,
		maskingKey: frame.maskKey,
		payload: frame.payload
	};
}

function getExtensionMessage(frame: WsFrame): WsExtensionMessage {
	return {
		rsv1: frame.RSV1,
		rsv2: frame.RSV2,
		rsv3: frame.RSV3,
		opcode: frame.opcode,
		data: frame.payload
	};
}

function fromExtensionMessage(msg: WsExtensionMessage): WsFrame {
	return {
		FIN: true,
		RSV1: msg.rsv1,
		RSV2: msg.rsv2,
		RSV3: msg.rsv3,
		opcode: msg.opcode,
		payloadLength: msg.data.length,
		payload: msg.data
	};
}

function getFrameOverheadLength(frame: WsFrame) {
	return 2                         // byte 1 = FIN, RSV1-3, opcode; byte 2 = MASK flag, payload length
		+ (frame.maskKey ? 4 : 0)    // mask keys are always 4 bytes if present
		+ getExtraPayloadLengthFieldSize(frame.payload.length);
}

function getExtraPayloadLengthFieldSize(payloadLength: number): number {
	if (payloadLength >= 126 && payloadLength <= 65535) {
		return 2; // 16-bit payload length
	} else if (payloadLength > 65535) {
		return 8; // 64-bit payload length
	} else {
		return 0; // no extra payload length field
	}
}
