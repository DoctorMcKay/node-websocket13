var parseUrl = require('url').parse;
var Socket = require('net').Socket;
var TLSSocket = require('tls').TLSSocket;
var Crypto = require('crypto');

const HTTP_VERSION = '1.1';
const WEBSOCKET_VERSION = 13;

require('util').inherits(WebSocket, require('events').EventEmitter);
module.exports = WebSocket;

WebSocket.State = {
	"Closed": 0,
	"Connecting": 1,
	"Connected": 2
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

	this._connect();
}

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
				this._handleData(data);
				break;
		}
	});

	this._socket.on('close', function() {
		console.log("Socket closed");
	});
};

WebSocket.prototype._closeError = function(err) {
	err.state = this.state;
	this.state = WebSocket.State.Closed;
	this._socket.end();
	this._socket.destroy();
	this.emit('error', err);
};

WebSocket.prototype._handleData = function(data) {
	if (data.length == 0) {
		return;
	}

	
};
