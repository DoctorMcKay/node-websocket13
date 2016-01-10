var WS13 = require('./index.js');
var StreamedFrame = require('./streamedframe.js');

var Crypto = require('crypto');
var ByteBuffer = require('bytebuffer');

require('util').inherits(WebSocketBase, require('events').EventEmitter);
module.exports = WebSocketBase;

function WebSocketBase() {
	this.state = WS13.State.Closed;
	this.extensions = [];
	this.protocol = null;

	this._outgoingFrames = []; // holds frame objects which we haven't sent yet
	this._dataBuffer = new Buffer(0); // holds raw TCP data that we haven't processed yet
	this._frameData = null; // holds the current frame for which we're still receiving payload data

	this.on('connected', () => {
		this._pingFailures = 0;
		this._queuePing();
	});
}

/**
 * Disconnect the websocket gracefully.
 * @param {number} [code=WS13.StatusCode.NormalClosure] - A value from the WS13.StatusCode enum to send to the other side
 * @param {string} [reason] - An optional reason string to send to the other side
 */
WebSocketBase.prototype.disconnect = function(code, reason) {
	if (this.state != WS13.State.Connected) {
		throw new Error("Cannot disconnect a WebSocket that is not connected.");
	}

	code = code || WS13.StatusCode.NormalClosure;
	reason = reason || "";

	var buf = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
	buf.writeUint16(code);
	buf.writeString(reason);

	this._sendControl(WS13.FrameType.Control.Close, buf.flip().toBuffer());
	this.state = WS13.State.Closing;

	setTimeout(() => {
		if (this.state != WS13.State.Closed) {
			this._socket.end();
		}
	}, 5000);
};

/**
 * Send some data in a single frame (not streamed).
 * @param {string|Buffer} data - The data to send. If a string, the data will be sent as UTF-8 text. If a Buffer, it will be sent as binary data.
 */
WebSocketBase.prototype.send = function(data) {
	var opcode = (typeof data === 'string' ? WS13.FrameType.Data.Text : WS13.FrameType.Data.Binary);
	if (ByteBuffer.isByteBuffer(data)) {
		data = data.toBuffer();
	} else if (typeof data === 'string') {
		data = new Buffer(data, 'utf8');
	}

	this._sendFrame({
		"FIN": true,
		"RSV1": false,
		"RSV2": false,
		"RSV3": false,
		"opcode": opcode,
		"payload": data
	});
};

WebSocketBase.prototype.createMessageStream = function(type) {
	var frame = new StreamedFrame(this, type);
	this._outgoingFrames.push(frame);
	return frame;
};

WebSocketBase.prototype._queuePing = function() {
	clearTimeout(this._pingTimer);
	clearTimeout(this._pingTimeout);

	if (this.state != WS13.State.Connected) {
		return;
	}

	if (!this.options.pingInterval || !this.options.pingTimeout || !this.options.pingFailures) {
		return;
	}

	this._pingTimer = setTimeout(() => {
		if (this.state != WS13.State.Connected) {
			return;
		}

		var bytes = Crypto.randomBytes(4);
		this._pingValue = bytes.readUInt32BE(0);

		this._sendFrame({
			"FIN": true,
			"RSV1": false,
			"RSV2": false,
			"RSV3": false,
			"opcode": WS13.FrameType.Control.Ping,
			"payload": bytes
		}, true);

		this._pingTimeout = setTimeout(() => {
			if (this.state != WS13.State.Connected) {
				return;
			}

			this.emit('debug', "Ping timeout #" + (this._pingFailures + 1));

			if (++this._pingFailures >= this.options.pingFailures) {
				this._closeError(new Error("Ping timeout"));
			} else {
				this._queuePing();
			}
		}, this.options.pingTimeout);
	}, this.options.pingInterval);
};

WebSocketBase.prototype._handleData = function(data) {
	if (data && data.length > 0) {
		this._dataBuffer = Buffer.concat([this._dataBuffer, data]);
	}

	if (this._dataBuffer.length == 0) {
		return;
	}

	try {
		var buf = ByteBuffer.wrap(this._dataBuffer, ByteBuffer.BIG_ENDIAN);
		var frame = {};

		var byte = buf.readUint8();
		frame.FIN = !!(byte & (1 << 7));
		frame.RSV1 = !!(byte & (1 << 6));
		frame.RSV2 = !!(byte & (1 << 5));
		frame.RSV3 = !!(byte & (1 << 4));
		frame.opcode = byte & 0x0F;

		byte = buf.readUint8();
		var hasMask = !!(byte & (1 << 7));
		frame.payloadLength = byte & 0x7F;

		if (frame.payloadLength == 126) {
			frame.payloadLength = buf.readUint16();
		} else if (frame.payloadLength == 127) {
			frame.payloadLength = buf.readUint64();
		}

		if (hasMask) {
			frame.maskKey = buf.readUint32();
		} else {
			frame.maskKey = null;
		}

		if (buf.remaining() < frame.payloadLength) {
			return; // We don't have the entire payload yet
		}

		frame.payload = buf.slice(buf.offset, buf.offset + frame.payloadLength).toBuffer();
		buf.skip(frame.payloadLength);
	} catch (ex) {
		// We don't have the full data yet. No worries.
		return;
	}

	// We have a full frame
	this._dataBuffer = buf.toBuffer();
	this._handleFrame(frame);

	this._handleData();
};

WebSocketBase.prototype._handleFrame = function(frame) {
	// Flags: FIN, RSV1, RSV2, RSV3
	// Ints: opcode (4 bits), payloadLength (up to 64 bits), maskKey (32 bits)
	// Binary: payload

	this.emit('debug', "Got frame " + frame.opcode.toString(16).toUpperCase() + ", " + (frame.FIN ? "FIN, " : "") +
		(frame.maskKey ? "MASK, " : "") + "payload " + frame.payload.length + " bytes");

	if (
		this.state != WS13.State.Connected &&
		!(
			(this.state == WS13.State.ClosingError || this.state == WS13.State.Closing) &&
			frame.opcode == WS13.FrameType.Control.Close
		)
	) {
		this.emit('debug', "Got frame " + frame.opcode.toString(16) + " while in state " + this.state);
		return;
	}

	var payload;

	// Is this a control frame?
	if (frame.opcode & (1 << 3)) {
		if (!frame.FIN) {
			this._terminateError(new Error("Got a fragmented control frame " + frame.opcode.toString(16)));
			return;
		}

		if (frame.payload.length > 125) {
			this._terminateError(new Error("Got a control frame " + frame.opcode.toString(16) + " with invalid payload length " + frame.payload.length));
			return;
		}

		if (frame.maskKey !== null && frame.payload && frame.payload.length > 0) {
			frame.payload = maskOrUnmask(frame.payload, frame.maskKey);
		}

		switch (frame.opcode) {
			case WS13.FrameType.Control.Close:
				var code = WS13.StatusCode.NoStatusCode;
				var reason = "";

				if (frame.payload && frame.payload.length >= 2) {
					code = frame.payload.readUInt16BE(0);

					if (frame.payload.length > 2) {
						reason = frame.payload.toString('utf8', 2);
					}
				}

				var state = this.state;
				this.state = WS13.State.Closed;
				this.emit('disconnected', code, reason, state == WS13.State.Closing);

				if (state == WS13.State.Closing || state == WS13.State.ClosingError) {
					this._socket.end();
					// We're all done here
				} else {
					payload = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
					payload.writeUint16(code);
					payload.writeString(reason || "");
					this._sendControl(WS13.FrameType.Control.Close, payload.flip().toBuffer());

					this._socket.end();
				}

				break;

			case WS13.FrameType.Control.Ping:
				this._sendControl(WS13.FrameType.Control.Pong, frame.payload);
				break;

			case WS13.FrameType.Control.Pong:
				if (frame.payload && frame.payload.length == 4 && frame.payload.readUInt32BE(0) == this._pingValue) {
					this._pingFailures = 0;
					this._queuePing();
				}

				break;

			default:
				this._terminateError(WS13.StatusCode.UnacceptableDataType, "Unknown control frame type " + frame.opcode.toString(16).toUpperCase());
		}

		return;
	}

	if (frame.opcode == WS13.FrameType.Continuation) {
		this.emit('debug', "Got continuation frame");
		var fin = frame.FIN;
		payload = frame.payload;

		frame = this._frameData;

		frame.FIN = fin;
		frame.payload = Buffer.concat([frame.payload, payload]);
	}

	if (!frame.FIN) {
		// There is more to come
		// TODO: Expose a Stream interface for these
		this.emit('debug', "Got non-FIN frame");
		this._frameData = frame;
		return;
	}

	// We know that we have this entire frame now. Let's handle it.
	// At this time we support no extensions so don't worry about extension data.

	if (frame.maskKey !== null && frame.payload && frame.payload.length > 0) {
		frame.payload = maskOrUnmask(frame.payload, frame.maskKey);
	}

	switch (frame.opcode) {
		case WS13.FrameType.Data.Text:
			var utf8 = frame.payload.toString('utf8');

			// Check that the UTF-8 is valid
			if (Buffer.compare(new Buffer(utf8, 'utf8'), frame.payload) !== 0) {
				// This is invalid. We must tear down the connection.
				this._terminateError(WS13.StatusCode.InconsistentData, "Received invalid UTF-8 data in a text frame.");
				return;
			}

			this.emit('message', WS13.FrameType.Data.Text, utf8);
			break;

		case WS13.FrameType.Data.Binary:
			this.emit('message', WS13.FrameType.Data.Binary, frame.payload);
			break;

		default:
			this._terminateError(WS13.StatusCode.UnacceptableDataType, "Unknown data frame type " + frame.opcode.toString(16).toUpperCase());
	}
};

WebSocketBase.prototype._sendFrame = function(frame, bypassQueue) {
	if (this.state != WS13.State.Connected) {
		throw new Error("Cannot send data while not connected.");
	}

	if (typeof frame.FIN === 'undefined') {
		frame.FIN = true;
	}

	if (frame.opcode & (1 << 3)) {
		bypassQueue = true; // we can send control messages whenever
	}

	frame.payload = frame.payload || new Buffer(0);
	if (frame.payload.length == 0) {
		frame.maskKey = null;
	}

	this.emit('debug', (bypassQueue ? "Sending" : "Queueing") + " frame " + frame.opcode.toString(16).toUpperCase() + ", " + (frame.FIN ? "FIN, " : "") +
		(frame.maskKey ? "MASK, " : "") + "payload " + frame.payload.length + " bytes");

	var size = 0;
	size += 1; // FIN, RSV1, RSV2, RSV3, opcode
	size += 1; // MASK, payload length

	if (frame.payload.length >= 126 && frame.payload.length <= 65535) {
		size += 2; // 16-bit payload length
	} else if (frame.payload.length > 65535) {
		size += 8; // 64-bit payload length
	}

	if (frame.maskKey) {
		size += 4;
	}

	size += frame.payload.length;

	var buf = new ByteBuffer(size, ByteBuffer.BIG_ENDIAN);
	var byte = 0;

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

	if (bypassQueue) {
		this._socket.write(buf.flip().toBuffer());
	} else {
		this._outgoingFrames.push(buf.flip().toBuffer());
	}

	this._processQueue();
};

WebSocketBase.prototype._processQueue = function() {
	var frame;
	var frames = this._outgoingFrames.slice(0);

	while (frames.length > 0) {
		frame = frames.splice(0, 1)[0];

		if (frame instanceof StreamedFrame) {
			if (!frame.started) {
				this.emit('debug', "Starting StreamedFrame");
				frame._start();
			}

			if (frame.finished) {
				continue;
			}

			return;
		}

		this._socket.write(frame);
	}

	this._outgoingFrames = frames;
};

WebSocketBase.prototype._sendControl = function(opcode, payload) {
	this._sendFrame({
		"opcode": opcode,
		"payload": payload,
		"payloadLength": payload.length,
		"FIN": true,
		"RSV1": false,
		"RSV2": false,
		"RSV3": false
	});
};

WebSocketBase.prototype._closeError = function(err) {
	err.state = this.state;
	this.state = WS13.State.Closed;
	this._socket.end();
	this._socket.destroy();
	this.emit('error', err);
};

WebSocketBase.prototype._terminateError = function(code, message) {
	var payload = new ByteBuffer(2 + message.length, ByteBuffer.BIG_ENDIAN);
	payload.writeUint16(code);
	payload.writeString(message || "");
	this._sendControl(WS13.FrameType.Control.Close, payload.flip().toBuffer());

	var err = new Error(message);
	err.state = this.state;
	err.code = code;
	this.emit('error', err);
};

// Util
function maskOrUnmask(data, maskKey) {
	var key = new Buffer(4);
	key.writeUInt32BE(maskKey);

	for (var i = 0; i < data.length; i++) {
		data[i] ^= key[i % 4];
	}

	return data;
}