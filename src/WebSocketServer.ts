import {createHash} from 'crypto';
import {EventEmitter} from 'events';
import {Server as HttpServer, IncomingMessage} from 'http';
import {Socket} from 'net';
import PermessageDeflate from 'permessage-deflate';
import {parse as parseUrl} from 'url';
import WebSocketExtensions from 'websocket-extensions';

import {HandshakeData, WebSocketServerOptions} from './interfaces-external';
import WebSocketServerConnection from './WebSocketServerConnection';
import HTTPStatusCodes from './enums/HTTPStatusCodes';

const HTTP_VERSION = 1.1;
const WEBSOCKET_VERSION = 13;

// eslint-disable-next-line
const PACKAGE_VERSION = require('../package.json').version;

export default class WebSocketServer extends EventEmitter {
	options: WebSocketServerOptions;
	protocols: string[];

	constructor(options: WebSocketServerOptions) {
		super();

		this.options = {
			pingInterval: 10000,
			pingTimeout: 10000,
			pingFailures: 3,
			permessageDeflate: true
		};

		options = options || {};
		Object.assign(this.options, options);

		this.protocols = this.options.protocols || [];
	}

	http(server: HttpServer) {
		server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
			if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() != 'websocket') {
				bail('Invalid upgrade type. Supported: websocket');
				return;
			}

			if (
				!req.headers.connection ||
				!req.headers.connection.toLowerCase().split(',').map(i => i.trim()).includes('upgrade')
			) {
				bail('Invalid upgrade request.');
				return;
			}

			let httpV = req.httpVersion.split('.');
			if (parseInt(httpV[0]) < 1 || parseInt(httpV[1]) < 1) {
				bail('Invalid HTTP version for websocket upgrade.');
				return;
			}

			if (req.method.toUpperCase() != 'GET') {
				bail('Bad HTTP method. Required: GET');
				return;
			}

			if (!req.headers['sec-websocket-key'] || Buffer.from(req.headers['sec-websocket-key'], 'base64').length != 16) {
				bail('Missing or invalid Sec-WebSocket-Key.');
				return;
			}

			if (req.headers['sec-websocket-version'] != WEBSOCKET_VERSION) {
				bail(`Sec-WebSocket-Version must be ${WEBSOCKET_VERSION}.`);
				return;
			}

			if (!socket.remoteAddress) {
				bail('Unable to determine IP address.');
				return;
			}

			let selectedProtocol = null;
			let protocols = [];
			if (req.headers['sec-websocket-protocol']) {
				protocols = req.headers['sec-websocket-protocol'].split(',').map(protocol => protocol.trim());
				// Do any of these match?

				for (let i = 0; i < protocols.length; i++) {
					if (this.protocols.indexOf(protocols[i]) != -1) {
						selectedProtocol = protocols[i];
						break;
					}
				}
			}

			let uri = parseUrl(req.url, true);

			let extensions = new WebSocketExtensions();
			if (this.options.permessageDeflate) {
				extensions.add(PermessageDeflate);
			}
			let selectedExtensions = extensions.generateResponse(req.headers['sec-websocket-extensions']);

			let handshakeData:HandshakeData = {
				path: uri.pathname,
				query: uri.query,
				headers: req.headers,
				httpVersion: req.httpVersion,
				origin: req.headers.origin || null,
				extensions: req.headers['sec-websocket-extensions'],
				extensionsHandler: extensions,
				selectedExtensions: selectedExtensions,
				protocols: protocols || [],
				selectedProtocol: selectedProtocol || null,
				auth: null,
				cookies: {},
				remoteAddress: socket.remoteAddress.replace(/^::ffff:/, ''),
				socket
			};

			// Does it have HTTP authorization?
			if (req.headers.authorization) {
				let match = req.headers.authorization.match(/basic ((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4}))/i);
				if (match) {
					handshakeData.auth = Buffer.from(match[1], 'base64').toString('utf8');
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
				socket.end(buildResponse(statusCode || 403, headers, body));
			}, (response) => {
				// ACCEPT
				response = response || {};
				let headers = response.headers || {};

				let options = {
					pingInterval: this.options.pingInterval,
					pingTimeout: this.options.pingTimeout,
					pingFailures: this.options.pingFailures,
					extensions
				};

				headers.Upgrade = 'websocket';
				headers.Connection = 'Upgrade';
				headers['Sec-WebSocket-Accept'] = createHash('sha1').update(
					req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
				).digest('base64');

				// Check if the accept method overrode our selected subprotocol
				if (typeof response.protocol !== 'undefined') {
					handshakeData.selectedProtocol = response.protocol || null;
				}

				if (response.extensions) {
					options.extensions = extensions = response.extensions;
					selectedExtensions = extensions.generateResponse(req.headers['sec-websocket-extensions']);
				}

				if (selectedExtensions) {
					headers['Sec-WebSocket-Extensions'] = selectedExtensions;
				}

				if (handshakeData.selectedProtocol) {
					headers['Sec-WebSocket-Protocol'] = handshakeData.selectedProtocol;
				}

				socket.write(buildResponse(101, headers));

				response.options = response.options || {};
				Object.assign(options, response.options);

				let websocket = new WebSocketServerConnection(socket, options, handshakeData, head);
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
	}
}



function buildResponse(code: number, headers: {[name: string]: any}, body?: string|{[name: string]: string}) {
	let response = `HTTP/${HTTP_VERSION} ${code} ${HTTPStatusCodes[code] || 'Unknown Response'}\r\n`;

	headers = headers || {};
	headers.Server = `node-websocket13/${PACKAGE_VERSION}`;
	headers.Date = new Date().toUTCString();

	if (typeof body === 'object') {
		body = JSON.stringify(body);
		headers['Content-Type'] = 'application/json';
	}

	if (body) {
		headers['Content-Length'] = Buffer.byteLength(body);
	} else if (code != 204 && code != 101) {
		headers['Content-Length'] = 0;
	}

	for (let i in headers) {
		response += `${i}: ${headers[i]}\r\n`;
	}

	response += '\r\n' + (typeof body !== 'undefined' ? body : '');
	return response;
}
