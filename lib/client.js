var WS13 = require('./index.js');
var WebSocketBase = require('./base.js');

var parseUrl = require('url').parse;
var Http = require('http');
var Https = require('https');
var Crypto = require('crypto');

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

	this._connectOptions = options.connection || {};
	for (var element in uri) {
		if (uri.hasOwnProperty(element) && uri[element] !== null) {
			this._connectOptions[element] = uri[element];
		}
	}

	this._connectOptions.protocol = this.secure ? "https:" : "http:";

	this.hostname = uri.hostname;
	this.port = this._connectOptions.port = parseInt(uri.port || (this.secure ? 443 : 80), 10);
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

	if (this.options.cookies) {
		this.headers.cookie = Object.keys(this.options.cookies).map(name => name.trim() + '=' + encodeURIComponent(this.options.cookies[name])).join('; ');
	}

	this._connect();
}

WebSocket.prototype._generateNonce = function() {
	this._nonce = Crypto.randomBytes(16).toString('base64');
	this.headers['sec-websocket-key'] = this._nonce;
};

WebSocket.prototype._connect = function() {
	this._generateNonce();

	this.state = WS13.State.Connecting;

	this._connectOptions.headers = this.headers;
	var req = (this.secure ? Https : Http).request(this._connectOptions, (res) => {
		var serverHttpVersion = res.httpVersion;
		var responseCode = res.statusCode;
		var responseText = res.statusMessage;
		var headers = res.headers;

		var err = new Error();
		err.responseCode = responseCode;
		err.responseText = responseText;
		err.httpVersion = serverHttpVersion;
		err.headers = res.headers;

		err.body = '';

		res.on('data', chunk => {
			err.body += chunk;
		});

		res.on('end', () => {
			if (this.state != WS13.State.Connecting) {
				return; // we don't care at this point
			}

			if (responseCode != 101) {
				err.message = "Response code " + responseCode;
				this._closeError(err);
				return;
			}

			err.message = "Server not upgrading connection";
			this._closeError(err);
		});
	});

	req.on('upgrade', (res, socket, head) => {
		var serverHttpVersion = res.httpVersion;
		var responseCode = res.statusCode;
		var responseText = res.statusMessage;
		var headers = res.headers;

		var err = new Error();
		err.responseCode = responseCode;
		err.responseText = responseText;
		err.httpVersion = serverHttpVersion;
		err.headers = res.headers;

		if (!headers.upgrade || !headers.connection || !headers.upgrade.match(/websocket/i) || !headers.connection.match(/upgrade/i)) {
			err.message = "Invalid server upgrade response";
			this._closeError(err);
			return;
		}

		if (!headers['sec-websocket-accept']) {
			err.message = "Missing Sec-WebSocket-Accept response header";
			this._closeError(err);
			return;
		}

		var hash = Crypto.createHash('sha1').update(this._nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest('base64');
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

		this._socket = socket;
		this._socket.on('data', (data) => {
			if ([WS13.State.Connected, WS13.State.Closing, WS13.State.ClosingError].indexOf(this.state) != -1) {
				this._handleData(data);
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
			err.state = this.state;
			this.state = WS13.State.ClosingError;
			this.emit('error', err);
		});

		// Everything is okay!
		this.state = WS13.State.Connected;
		this.emit('connected', {
			"headers": headers,
			"httpVersion": serverHttpVersion,
			"responseCode": responseCode,
			"responseText": responseText
		});

		if (head && head.length > 0) {
			this._handleData(head);
		}
	});

	req.on('error', (err) => {
		if (this.state != WS13.State.Connecting) {
			return;
		}

		err.state = this.state;
		this.emit('error', err);
	});

	req.end();
};

WebSocket.prototype._sendFrame = function(frame) {
	frame.maskKey = Crypto.randomBytes(32).readUInt32BE(0);
	WebSocketBase.prototype._sendFrame.apply(this, arguments);
};
