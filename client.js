var WS13 = require('./index.js');
var WebSocketBase = require('./base.js');

var parseUrl = require('url').parse;
var Net = require('net');
var TLS = require('tls');
var Crypto = require('crypto');

const HTTP_VERSION = 1.1;
const WEBSOCKET_VERSION = 13;

require('util').inherits(WebSocket, WebSocketBase);
WS13.WebSocket = WebSocket;

function WebSocket(uri, options) {
	WebSocketBase.call(this);

	uri = parseUrl(uri);

	switch (uri.protocol.toLowerCase()) {
		case 'ws:':
			this.secure = false;
			break;

		case 'wss:':
			this.secure = true;
			break;

		default:
			throw new Error("Unknown protocol scheme " + uri.protocol);
	}

	this.options = {
		"pingInterval": 10000,
		"pingTimeout": 10000,
		"pingFailures": 3
	};

	options = options || {};
	for (var option in options) {
		if (options.hasOwnProperty(option)) {
			this.options[option] = options[option];
		}
	}

	this.hostname = uri.hostname;
	this.port = parseInt(uri.port || (this.secure ? 443 : 80), 10);
	this.path = uri.path || '/';

	this.headers = this.options.headers || {};
	// Lowercase all the header names so we don't conflict
	for (var i in this.headers) {
		if (this.headers.hasOwnProperty(i) && i.match(/[^a-z]/)) {
			this.headers[i.toLowerCase()] = this.headers[i];
			delete this.headers[i];
		}
	}

	this.headers.host = uri.host;
	this.headers.upgrade = 'websocket';
	this.headers.connection = 'Upgrade';
	this.headers['sec-websocket-version'] = WEBSOCKET_VERSION;

	if (this.options.protocols) {
		this.options.protocols = this.options.protocols.map(protocol => protocol.trim().toLowerCase());
		this.headers['sec-websocket-protocol'] = this.options.protocols.join(', ');
	}

	// TODO: Cookies

	this._connect();
}

WebSocket.prototype._generateNonce = function() {
	this.nonce = Crypto.randomBytes(16).toString('base64');
	this.headers['sec-websocket-key'] = this.nonce;
};

WebSocket.prototype._connect = function() {
	this._generateNonce();

	this.state = WS13.State.Connecting;

	var connectOptions = this.options.connection || {};
	connectOptions.port = this.port;
	connectOptions.host = this.hostname;

	this._socket = Net.connect(connectOptions);
	var event = 'connect';

	if (this.secure) {
		connectOptions.socket = this._socket;
		this._socket = TLS.connect(connectOptions);
		event = 'secureConnect';
	}

	this._socket.on(event, () => {
		// Time to send the handshake
		this._socket.write("GET " + this.path + " HTTP/" + HTTP_VERSION + "\r\n");

		// Send headers
		for (var name in this.headers) {
			if (this.headers.hasOwnProperty(name)) {
				this._socket.write(name + ": " + this.headers[name] + "\r\n");
			}
		}

		this._socket.write("\r\n");
	});

	var handshakeBuffer = '';

	this._socket.on('data', (data) => {
		switch (this.state) {
			case WS13.State.Connecting:
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
						this.state = WS13.State.Closed;
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
					this.state = WS13.State.Connected;
					this.emit('connected', {
						"headers": headers,
						"httpVersion": serverHttpVersion,
						"responseCode": responseCode,
						"responseText": responseText
					});
				}

				break;

			case WS13.State.Connected:
			case WS13.State.Closing:
			case WS13.State.ClosingError:
				this._handleData(data);
				break;
		}
	});

	this._socket.on('close', () => {
		if (this.state == WS13.State.ClosingError) {
			this.state = WS13.State.Closing;
			return;
		}

		if (this.state == WS13.State.Closed) {
			this.emit('debug', "Socket closed after successful websocket closure.");
			return;
		}

		var state = this.state;
		this.state = WS13.State.Closed;
		this.emit('disconnected', WS13.StatusCode.AbnormalTermination, "Socket closed", state == WS13.State.Closing);
	});

	this._socket.on('error', (err) => {
		this.state = WS13.State.ClosingError;
		this.emit('error', err);
	});
};

WebSocket.prototype._sendFrame = function(frame) {
	frame.maskKey = Crypto.randomBytes(32).readUInt32BE(0);
	WebSocketBase.prototype._sendFrame.apply(this, arguments);
};
