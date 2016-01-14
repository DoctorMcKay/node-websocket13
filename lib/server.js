var WS13 = require('./index.js');
var WebSocketBase = require('./base.js');
var HTTPStatusCodes = require('../resources/HTTPStatusCodes.json');

var parseUrl = require('url').parse;
var Crypto = require('crypto');

const HTTP_VERSION = 1.1;
const WEBSOCKET_VERSION = 13;

WS13.WebSocketServer = WebSocketServer;
require('util').inherits(WebSocketServer, require('events').EventEmitter);

function WebSocketServer(options) {
	this.options = {
		"pingInterval": 10000,
		"pingTimeout": 10000,
		"pingFailures": 3
	};

	options = options || {};
	for (var i in options) {
		if (options.hasOwnProperty(i)) {
			this.options[i] = options[i];
		}
	}

	this.protocols = this.options.protocols || [];
}

WebSocketServer.prototype.http = function(server) {
	server.on('upgrade', (req, socket, head) => {
		if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() != "websocket") {
			bail("Invalid upgrade type. Supported: websocket");
			return;
		}

		if (!req.headers.connection || req.headers.connection.toLowerCase().split(',').map(item => item.trim()).indexOf("upgrade") == -1) {
			bail("Invalid upgrade request.");
			return;
		}

		var httpV = req.httpVersion.split('.');
		if (httpV[0] < 1 || httpV[1] < 1) {
			bail("Invalid HTTP version for websocket upgrade.");
			return;
		}

		if (req.method.toUpperCase() != 'GET') {
			bail("Bad HTTP method. Required: GET");
			return;
		}

		if (!req.headers['sec-websocket-key'] || new Buffer(req.headers['sec-websocket-key'], 'base64').length != 16) {
			bail("Missing or invalid Sec-WebSocket-Key.");
			return;
		}

		if (req.headers['sec-websocket-version'] != WEBSOCKET_VERSION) {
			bail("Sec-WebSocket-Version must be " + WEBSOCKET_VERSION + ".");
			return;
		}

		if (req.headers['sec-websocket-protocol']) {
			var protocols = req.headers['sec-websocket-protocol'].split(',').map(protocol => protocol.trim());
			// Do any of these match?

			var selectedProtocol = null;
			for (var i = 0; i < protocols.length; i++) {
				if (this.protocols.indexOf(protocols[i]) != -1) {
					selectedProtocol = protocols[i];
					break;
				}
			}
		}

		var uri = parseUrl(req.url, true);

		var handshakeData = {
			"path": uri.pathname,
			"query": uri.query,
			"headers": req.headers,
			"httpVersion": req.httpVersion,
			"origin": req.headers.origin || null,
			"extensions": [],
			"selectedExtensions": [],
			"protocols": protocols || null,
			"selectedProtocol": selectedProtocol || null,
			"auth": null,
			"cookies": [],
			"remoteAddress": socket.remoteAddress.replace(/^::ffff:/, ''),
			"socket": socket
		};

		// Does it have HTTP authorization?
		if (req.headers.authorization) {
			var match = req.headers.authorization.match(/basic ((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4}))/i);
			if (match) {
				handshakeData.auth = new Buffer(match[1], 'base64').toString('utf8');
			}
		}

		// Does it have cookies?
		if (req.headers.cookie) {
			req.headers.cookie.split(';').map(cookie => cookie.trim().split('=')).forEach(cookie => {
				handshakeData.cookies[cookie[0].trim()] = decodeURIComponent(cookie.slice(1).join('=').trim());
			});
		}

		// Everything looks okay so far, make sure we'd like to accept this.
		this.emit('handshake', handshakeData, (statusCode, body, headers) => {
			// REJECT
			req.statusCode = statusCode || 403;
			headers = headers || {};

			if (typeof body === 'object') {
				body = JSON.stringify(body);
				headers['content-type'] = 'application/json';
			}

			socket.end(buildResponse(statusCode || 403, headers, body));
		}, (response) => {
			// ACCEPT
			response = response || {};
			var headers = response.headers || {};

			headers.Upgrade = "websocket";
			headers.Connection = "Upgrade";
			headers['Sec-WebSocket-Accept'] = Crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest('base64');

			// Check if the accept method overrode our selected subprotocol
			if (typeof response.protocol !== 'undefined') {
				handshakeData.selectedProtocol = response.protocol || null;
			}

			if (handshakeData.selectedProtocol) {
				headers['Sec-WebSocket-Protocol'] = handshakeData.selectedProtocol;
			}

			socket.write(buildResponse(101, headers));

			var options = {
				"pingInterval": this.options.pingInterval,
				"pingTimeout": this.options.pingTimeout,
				"pingFailures": this.options.pingFailures
			};

			response.options = response.options || {};
			for (var i in response.options) {
				if (response.options.hasOwnProperty(i)) {
					options[i] = response.options[i];
				}
			}

			var websocket = new WebSocket(socket, options, handshakeData, head);
			this.emit('connection', websocket);
			return websocket;
		});

		function bail(err) {
			if (server.listenerCount('upgrade') != 1) {
				// Something else could pick this up
				return;
			}

			socket.end(buildResponse(400, null, err));
		}
	});
};

function buildResponse(code, headers, body) {
	var response = "HTTP/" + HTTP_VERSION + " " + code + " " + (HTTPStatusCodes[code] || "Unknown Response") + "\r\n";

	headers = headers || {};
	headers.Server = "node-websocket13/" + require('../package.json').version;
	headers.Date = new Date().toUTCString();

	if (typeof body === 'object') {
		body = JSON.stringify(body);
		headers['Content-Type'] = 'application/json';
	}

	if (body) {
		headers['Content-Length'] = body.length;
	}

	for (var i in headers) {
		if (headers.hasOwnProperty(i)) {
			response += i + ": " + headers[i] + "\r\n";
		}
	}

	response += "\r\n" + (typeof body !== 'undefined' ? body : '');
	return response;
}

// Server-spawned WebSocket object
require('util').inherits(WebSocket, WebSocketBase);

function WebSocket(socket, options, handshakeData, head) {
	WebSocketBase.call(this);

	options = options || {};
	for (var i in options) {
		if (options.hasOwnProperty(i)) {
			this.options[i] = options[i];
		}
	}

	this.state = WS13.State.Connected;
	this.handshakeData = handshakeData;
	this.extensions = handshakeData.selectedExtensions || [];
	this.protocol = handshakeData.selectedProtocol || null;
	this.remoteAddress = socket.remoteAddress;

	this._socket = socket;
	this._data = {};

	this._prepSocketEvents();
	if (head && head.length > 0) {
		this._dataBuffer = head; // don't call _handleData just yet, as there are no event listeners bound
	}
}

WebSocket.prototype.data = function(key, value) {
	var val = this._data[key];

	if (typeof value === 'undefined') {
		return val;
	}

	this._data[key] = value;
	return val;
};
