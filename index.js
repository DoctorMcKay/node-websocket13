var parseUrl = require('url').parse;
var Socket = require('net').Socket;
var TLSSocket = require('tls').TLSSocket;
var Crypto = require('crypto');
var ByteBuffer = require('bytebuffer');

const HTTP_VERSION = '1.1';
const WEBSOCKET_VERSION = 13;

require('util').inherits(WebSocket, require('events').EventEmitter);
module.exports = WebSocket;

WebSocket.State = {
	"Closed": 0,
	"Connecting": 1,
	"Connected": 2,
	"Closing": 3,
	"ClosingError": 4
};

WebSocket.FrameType = {
	"Continuation": 0x0,

	"Data": {
		"Text": 0x1,
		"Binary": 0x2
	},

	"Control": {
		"Close": 0x8,
		"Ping": 0x9,
		"Pong": 0xA
	}
};

WebSocket.StatusCode = {
	"NormalClosure": 1000,         /** Graceful disconnection */
	"EndpointGoingAway": 1001,     /** Closing connection because either the server or the client is going down (e.g. browser navigating away) */
	"ProtocolError": 1002,         /** Either side is terminating the connection due to a protocol error */
	"UnacceptableDataType": 1003,  /** Terminating because either side received data that it can't accept or process */
	"Reserved1": 1004,             /** Reserved. Do not use. */
	"NoStatusCode": 1005,          /** MUST NOT be sent over the wire. Used internally when no status code was sent. */
	"AbnormalTermination": 1006,   /** MUST NOT be sent over the wire. Used internally when the connection is closed without sending/receiving a Close frame. */
	"InconsistentData": 1007,      /** Terminating because either side received data that wasn't consistent with the expected type */
	"PolicyViolation": 1008,       /** Generic. Terminating because either side received a message that violated its policy */
	"MessageTooBig": 1009,         /** Terminating because either side received a message that is too big to process */
	"MissingExtension": 1010,      /** Client is terminating because the server didn't negotiate one or more extensions that we require */
	"UnexpectedCondition": 1011,   /** Server is terminating because it encountered an unexpected condition that prevented it from fulfilling the request */
	"TLSFailed": 1015              /** MUST NOT be sent over the wire. Used internally when TLS handshake fails. */
};

function WebSocket(uri, options) {
	this.state = WebSocket.State.Closed;
	this.uri = parseUrl(uri);

	switch (this.uri.protocol.toLowerCase()) {
		case 'ws:':
			this.secure = false;
			break;

		case 'wss:':
			this.secure = true;
			break;

		default:
			throw new Error("Unknown protocol scheme " + this.uri.protocol);
	}

	this.options = options || {};

	this.hostname = this.uri.hostname;
	this.port = parseInt(this.uri.port || (this.secure ? 443 : 80), 10);
	this.path = this.uri.path || '/';

	this.headers = this.options.headers || {};
	// Lowercase all the header names so we don't conflict
	for (var i in this.headers) {
		if (this.headers.hasOwnProperty(i) && i.match(/[^a-z]/)) {
			this.headers[i.toLowerCase()] = this.headers[i];
			delete this.headers[i];
		}
	}

	this.headers.host = this.uri.host;
	this.headers.upgrade = 'websocket';
	this.headers.connection = 'Upgrade';
	this.headers['sec-websocket-version'] = WEBSOCKET_VERSION;

	this.extensions = [];

	if (this.options.protocols) {
		this.options.protocols = this.options.protocols.map(protocol => protocol.trim().toLowerCase());
		this.headers['sec-websocket-protocol'] = this.options.protocols.join(', ');
	}

	// TODO: Cookies

	this._dataBuffer = new Buffer(0); // holds raw TCP data that we haven't processed yet
	this._frameData = null; // holds the metadata for the current frame whose payload data we're holding
	this._frameBuffer = new Buffer(0); // holds frame payload data that we haven't dispatched to be handled yet
	this._connect();
}

/**
 * Disconnect the websocket gracefully.
 * @param {number} [code=WebSocket.StatusCode.NormalClosure] - A value from the WebSocket.StatusCode enum to send to the other side
 * @param {string} [reason] - An optional reason string to send to the other side
 */
WebSocket.prototype.disconnect = function(code, reason) {
	code = code || WebSocket.StatusCode.NormalClosure;
	reason = reason || "";

	var buf = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
	buf.writeUint16(code);
	buf.writeString(reason);

	this._sendControl(WebSocket.FrameType.Control.Close, buf.flip().toBuffer());
	this.state = WebSocket.State.Closing;
};

WebSocket.prototype._generateNonce = function() {
	this.nonce = Crypto.randomBytes(16).toString('base64');
	this.headers['sec-websocket-key'] = this.nonce;
};

WebSocket.prototype._connect = function() {
	this._generateNonce();
	this._socket = (this.secure ? new TLSSocket() : new Socket());

	this.state = WebSocket.State.Connecting;

	this._socket.connect({
		"port": this.port,
		"host": this.hostname
	}, () => {
		// Time to send the handshake
		var out = '';

		out += "GET " + this.path + " HTTP/" + HTTP_VERSION + "\r\n";

		// Send headers
		for (var name in this.headers) {
			if (this.headers.hasOwnProperty(name)) {
				out += name + ": " + this.headers[name] + "\r\n";
			}
		}

		out += "\r\n";
		this._socket.write(out);
	});

	var handshakeBuffer = '';

	this._socket.on('data', (data) => {
		switch (this.state) {
			case WebSocket.State.Connecting:
				handshakeBuffer += data.toString('ascii');
				var pos = handshakeBuffer.indexOf("\r\n\r\n");
				if (pos != -1) {
					// Anything after these characters is actual websocket data
					this._handleData(new Buffer(handshakeBuffer.slice(pos + 4), 'ascii'));
					handshakeBuffer = handshakeBuffer.substring(0, pos);

					// Now we have our full headers
					var lines = handshakeBuffer.split("\r\n");
					var match = lines[0].match(/^HTTP\/(\d+\.\d+) (\d+) (.+)$/);
					if (!match) {
						this.state = WebSocket.State.Closed;
						this.emit('error', new Error("Malformed handshake response"));
						return;
					}

					var serverHttpVersion = match[1];
					var responseCode = parseInt(match[2], 10);
					var responseText = match[3];

					var err = new Error();
					err.responseCode = responseCode;
					err.responseText = responseText;
					err.httpVersion = serverHttpVersion;

					if (responseCode != 101) {
						err.message = "Response code " + responseCode;
						this._closeError(err);
						return;
					}

					// Parse out our headers
					var headers = {};
					lines.slice(1).forEach(line => {
						match = line.match(/^([^:]+): ?(.+)$/);
						if (!match) {
							// Malformed response header, let's just ignore it
							return;
						}

						headers[match[1].toLowerCase()] = match[2].trim();
					});

					err.headers = headers;

					if (!headers.upgrade || !headers.connection || !headers.upgrade.match(/websocket/i) || !headers.connection.match(/upgrade/i)) {
						err.message = "Server not upgrading connection";
						this._closeError(err);
						return;
					}

					if (!headers['sec-websocket-accept']) {
						err.message = "Missing Sec-WebSocket-Accept response header";
						this._closeError(err);
						return;
					}

					var hash = Crypto.createHash('sha1').update(this.nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest('base64');
					if (headers['sec-websocket-accept'] != hash) {
						err.message = "Mismatching Sec-WebSocket-Accept header";
						err.expected = hash;
						err.actual = headers['sec-websocket-accept'];
						this._closeError(err);
						return;
					}

					if (headers['sec-websocket-extensions']) {
						var extensions = headers['sec-websocket-extensions'].split(',').map(item => item.trim().toLowerCase());
						var unsupported = extensions.filter(extension => this.extensions.indexOf(extension) == -1);
						if (unsupported.length > 0) {
							err.message = "Server is using unsupported extension" + (unsupported.length > 1 ? "s" : "") + unsupported.join(', ');
							this._closeError(err);
							return;
						}

						this.extensions = extensions;
					}

					if (headers['sec-websocket-protocol']) {
						var protocol = headers['sec-websocket-protocol'].toLowerCase();
						if (this.options.protocols.indexOf(protocol) == -1) {
							err.message = "Server is using unsupported protocol " + protocol;
							this._closeError(err);
							return;
						}

						this.protocol = protocol;
					}

					// Everything is okay!
					this.state = WebSocket.State.Connected;
					this.emit('connected', {
						"headers": headers,
						"httpVersion": serverHttpVersion,
						"responseCode": responseCode,
						"responseText": responseText
					});
				}

				break;

			case WebSocket.State.Connected:
			case WebSocket.State.Closing:
			case WebSocket.State.ClosingError:
				this._handleData(data);
				break;
		}
	});

	this._socket.on('close', () => {
		if (this.state == WebSocket.State.ClosingError) {
			this.state = WebSocket.State.Closing;
			return;
		}

		if (this.state == WebSocket.State.Closed) {
			this.emit('debug', "Socket closed after successful websocket closure.");
			return;
		}

		var state = this.state;
		this.state = WebSocket.State.Closed;
		this.emit('disconnected', WebSocket.StatusCode.AbnormalTermination, "Socket closed", state == WebSocket.State.Closing);
	});

	this._socket.on('error', (err) => {
		this.state = WebSocket.State.ClosingError;
		this.emit('error', err);
	});
};

WebSocket.prototype._handleData = function(data) {
	if (data && data.length > 0) {
		this._dataBuffer = Buffer.concat([this._dataBuffer, data]);
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

WebSocket.prototype._handleFrame = function(frame) {
	// Flags: FIN, RSV1, RSV2, RSV3
	// Ints: opcode (4 bits), payloadLength (up to 64 bits), maskKey (32 bits)
	// Binary: payload

	this.emit('debug', "Got frame " + frame.opcode.toString(16).toUpperCase() + ", " + (frame.FIN ? "FIN, " : "") +
		(frame.maskKey ? "MASK, " : "") + "payload " + frame.payload.length + " bytes");

	if (
		this.state != WebSocket.State.Connected &&
		!(
			(this.state == WebSocket.State.ClosingError || this.state == WebSocket.State.Closing) &&
			frame.opcode == WebSocket.FrameType.Control.Close
		)
	) {
		this.emit('debug', "Got frame " + frame.opcode.toString(16) + " while in state " + this.state);
		return;
	}

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
			case WebSocket.FrameType.Control.Close:
				var code = WebSocket.StatusCode.NoStatusCode;
				var reason = "";

				if (frame.payload && frame.payload.length >= 2) {
					code = frame.payload.readUInt16BE(0);

					if (frame.payload.length > 2) {
						reason = frame.payload.toString('utf8', 2);
					}
				}

				var state = this.state;
				this.state = WebSocket.State.Closed;
				this.emit('disconnected', code, reason, state == WebSocket.State.Closing);

				if (state == WebSocket.State.Closing || state == WebSocket.State.ClosingError) {
					this._socket.end();
					// We're all done here
				} else {
					var payload = new ByteBuffer(2 + reason.length, ByteBuffer.BIG_ENDIAN);
					payload.writeUint16(code);
					payload.writeString(reason || "");
					this._sendControl(WebSocket.FrameType.Control.Close, payload.flip().toBuffer());

					this._socket.end();
				}

				break;

			case WebSocket.FrameType.Control.Ping:
				this._sendControl(WebSocket.FrameType.Control.Pong, frame.payload);
				break;

			case WebSocket.FrameType.Control.Pong:
				// TODO: Cancel any ping timeouts
				break;

			default:
				this._terminateError(WebSocket.StatusCode.UnacceptableDataType, "Unknown control frame type " + frame.opcode.toString(16).toUpperCase());
		}

		return;
	}

	if (frame.opcode == WebSocket.FrameType.Continuation) {
		this.emit('debug', "Got continuation frame");
		frame = this._frameData;
		frame.payload = this._frameBuffer.concat(frame.payload);
	}

	if (!frame.FIN) {
		// There is more to come
		this.emit('debug', "Got non-FIN frame");
		this._frameBuffer = frame.payload;
		this._frameData = frame;
		return;
	}

	// We know that we have this entire frame now. Let's handle it.
	// At this time we support no extensions so don't worry about extension data.

	if (frame.maskKey !== null && frame.payload && frame.payload.length > 0) {
		frame.payload = maskOrUnmask(frame.payload, frame.maskKey);
	}

	switch (frame.opcode) {
		case WebSocket.FrameType.Data.Text:
			var utf8 = frame.payload.toString('utf8');

			// Check that the UTF-8 is valid
			if (!Buffer.compare(new Buffer(utf8, 'utf8'), frame.payload)) {
				// This is invalid. We must tear down the connection.
				this._terminateError(WebSocket.StatusCode.InconsistentData, "Received invalid UTF-8 data in a text frame.");
				return;
			}

			this.emit('message', WebSocket.FrameType.Data.Text, utf8);
			break;

		case WebSocket.FrameType.Data.Binary:
			this.emit('message', WebSocket.FrameType.Data.Binary, frame.payload);
			break;

		default:
			this._terminateError(WebSocket.StatusCode.UnacceptableDataType, "Unknown data frame type " + frame.opcode.toString(16).toUpperCase());
	}
};

WebSocket.prototype._sendFrame = function(frame) {
	if (typeof frame.FIN === 'undefined') {
		frame.FIN = true;
	}

	frame.maskKey = Crypto.randomBytes(32).readUInt32BE(0);
	frame.payload = frame.payload || new Buffer(0);

	this.emit('debug', "Sending frame " + frame.opcode.toString(16).toUpperCase() + ", " + (frame.FIN ? "FIN, " : "") +
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

	this._socket.write(buf.flip().toBuffer());
};

WebSocket.prototype._sendControl = function(opcode, payload) {
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

WebSocket.prototype._closeError = function(err) {
	err.state = this.state;
	this.state = WebSocket.State.Closed;
	this._socket.end();
	this._socket.destroy();
	this.emit('error', err);
};

WebSocket.prototype._terminateError = function(code, message) {
	var payload = new ByteBuffer(2 + message.length, ByteBuffer.BIG_ENDIAN);
	payload.writeUint16(code);
	payload.writeString(message || "");
	this._sendControl(WebSocket.FrameType.Control.Close, payload.flip().toBuffer());

	var err = new Error(message);
	err.code = code;
	this.emit('error', err);
};

function maskOrUnmask(data, key) {
	key = new Buffer(4);
	key.writeUInt32BE(key);

	for (var i = 0; i < data.length; i++) {
		data[i] = data[i] ^ key[i % 4];
	}

	return data;
}
