import {randomBytes, createHash} from 'crypto';
import {Agent, request as httpRequest, RequestOptions} from 'http';
import {request as httpsRequest} from 'https';
import {release as osRelease, arch as osArch} from 'os';
import StdLib from '@doctormckay/stdlib';
import {parse as parseUrl} from 'url';
import WebSocketExtensions from 'websocket-extensions';

import WebSocketBase from './WebSocketBase';
import {WebSocketClientConnectionOptionsInternal, WebSocketConnectEventArgs, WsFrame} from './interfaces-internal';
import {WebSocketClientOptions} from './interfaces-external';
import State from './enums/State';

const WEBSOCKET_VERSION = 13;

// eslint-disable-next-line
const PACKAGE_VERSION = require('../package.json').version;

export default class WebSocket extends WebSocketBase {
	secure: boolean;
	hostname: string;
	port: number;
	path: string;
	headers: any;
	options: WebSocketClientOptions;

	_connectOptions: WebSocketClientConnectionOptionsInternal;
	_nonce: string;

	constructor(url: string, options?: WebSocketClientOptions) {
		super();

		let parsedUri = parseUrl(url);

		switch (parsedUri.protocol.toLowerCase()) {
			case 'ws:':
				this.secure = false;
				break;

			case 'wss:':
				this.secure = true;
				break;

			default:
				throw new Error(`Unknown protocol scheme ${parsedUri.protocol}`);
		}

		options = options || {};
		Object.assign(this.options, options);

		let connectOptions:any = options.connection || {};
		for (let element in parsedUri) {
			if (parsedUri[element] !== null) {
				connectOptions[element] = parsedUri[element];
			}
		}

		connectOptions.protocol = this.secure ? 'https:' : 'http:';

		this.hostname = parsedUri.hostname;
		this.port = connectOptions.port = parseInt((parsedUri.port || (this.secure ? 443 : 80)).toString(), 10);
		this.path = parsedUri.path || '/';

		this._connectOptions = connectOptions;

		// clone the headers object so we don't unexpectedly modify the object that was passed in
		this.headers = JSON.parse(JSON.stringify(this.options.headers || {}));
		// Lowercase all the header names so we don't conflict (but only if they aren't already lowercase)
		for (let i in this.headers) {
			if (i.toLowerCase() != i) {
				this.headers[i.toLowerCase()] = this.headers[i];
				delete this.headers[i];
			}
		}

		this.headers.host = this.headers.host || parsedUri.host;
		this.headers.upgrade = 'websocket';
		this.headers.connection = 'Upgrade';
		this.headers['sec-websocket-version'] = WEBSOCKET_VERSION;
		this.headers['user-agent'] = this.headers['user-agent'] ||
			[
				`node.js/${process.versions.node} (${process.platform} ${osRelease()} ${osArch()})`,
				`node-websocket13/${PACKAGE_VERSION}`
			].join(' ');

		// permessageDeflate defaults to true, so only if it's false should we disable it
		if (this.options.permessageDeflate === false) {
			this._extensions = new WebSocketExtensions();
		}

		let extOffer = this._extensions.generateOffer();
		if (extOffer) {
			this.headers['sec-websocket-extensions'] = extOffer;
		}

		if (this.options.protocols) {
			this.options.protocols = this.options.protocols.map(protocol => protocol.trim().toLowerCase());
			this.headers['sec-websocket-protocol'] = this.options.protocols.join(', ');
		}

		if (this.options.cookies) {
			this.headers.cookie = Object.keys(this.options.cookies).map(name => name.trim() + '=' + encodeURIComponent(this.options.cookies[name])).join('; ');
		}

		this._type = 'client';

		this._connect();
	}

	_generateNonce(): void {
		this._nonce = randomBytes(16).toString('base64');
		this.headers['sec-websocket-key'] = this._nonce;
	}

	_connect() {
		this._generateNonce();

		this.state = State.Connecting;

		if (this.options.handshakeBody) {
			this.headers['content-length'] = this.options.handshakeBody.length;
		}

		this._connectOptions.headers = this.headers;
		if (this.secure && this.headers.host && typeof this._connectOptions.servername == 'undefined') {
			this._connectOptions.servername = this.headers.host.split(':')[0];
		}

		if (this.options.httpProxy) {
			if (this._connectOptions.agent) {
				console.error('[websocket13] Warning: "agent" connection option specified; httpProxy option ignored');
			} else {
				this._connectOptions.agent = StdLib.HTTP.getProxyAgent(this.secure, this.options.httpProxy, this.options.proxyTimeout) as Agent;
			}
		}

		let reqFunc = this.secure ? httpsRequest : httpRequest;
		let req = reqFunc(this._connectOptions as RequestOptions, (res) => {
			let serverHttpVersion = res.httpVersion;
			let responseCode = res.statusCode;
			let responseText = res.statusMessage;

			let err:any = new Error();
			err.responseCode = responseCode;
			err.responseText = responseText;
			err.httpVersion = serverHttpVersion;
			err.headers = res.headers;

			err.body = '';

			res.on('data', chunk => {
				err.body += chunk;
			});

			res.on('end', () => {
				if (this.state != State.Connecting) {
					return; // we don't care at this point
				}

				if (responseCode != 101) {
					err.message = `Response code ${responseCode}`;
					this._closeError(err);
					return;
				}

				err.message = 'Server not upgrading connection';
				this._closeError(err);
			});
		});

		req.on('upgrade', (res, socket, head) => {
			let serverHttpVersion = res.httpVersion;
			let responseCode = res.statusCode;
			let responseText = res.statusMessage;
			let headers = res.headers;

			let err:any = new Error();
			err.responseCode = responseCode;
			err.responseText = responseText;
			err.httpVersion = serverHttpVersion;
			err.headers = res.headers;

			if (!headers.upgrade || !headers.connection || !headers.upgrade.match(/websocket/i) || !headers.connection.match(/upgrade/i)) {
				err.message = 'Invalid server upgrade response';
				this._closeError(err);
				return;
			}

			if (!headers['sec-websocket-accept']) {
				err.message = 'Missing Sec-WebSocket-Accept response header';
				this._closeError(err);
				return;
			}

			let hash = createHash('sha1').update(this._nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
			if (headers['sec-websocket-accept'] != hash) {
				err.message = 'Mismatching Sec-WebSocket-Accept header';
				err.expected = hash;
				err.actual = headers['sec-websocket-accept'];
				this._closeError(err);
				return;
			}

			if (this.state == State.Closing) {
				// we wanted to abort this connection
				this.emit('debug', 'Closing newly-established connection due to abort');
				socket.end();
				socket.destroy();
				return;
			}

			if (headers['sec-websocket-protocol']) {
				let protocol = (headers['sec-websocket-protocol'] as string).toLowerCase();
				if (this.options.protocols.indexOf(protocol) == -1) {
					err.message = `Server is using unsupported protocol ${protocol}`;
					this._closeError(err);
					return;
				}

				this.protocol = protocol;
			}

			try {
				this._extensions.activate(headers['sec-websocket-extensions']);
			} catch (ex) {
				err.message = ex.message;
				this._closeError(err);
				return;
			}

			this._socket = socket;
			this._prepSocketEvents();
			this._resetUserTimeout();

			// Everything is okay!
			this.state = State.Connected;
			let connectEventArgs:WebSocketConnectEventArgs = {
				headers: headers as {[name: string]: string},
				httpVersion: serverHttpVersion,
				responseCode,
				responseText
			};
			this.emit('connected', connectEventArgs);
			this.emit('connect', connectEventArgs); // save people from typos
			this._onConnected();

			if (head && head.length > 0) {
				this._handleData(head);
			}
		});

		req.on('error', (err:any) => {
			if (this.state != State.Connecting) {
				return;
			}

			err.state = this.state;
			this.emit('error', err);
		});

		req.end(this.options.handshakeBody);
	}

	_sendFrame(frame: WsFrame, bypassQueue = false): void {
		frame.maskKey = randomBytes(4).readUInt32BE(0);
		super._sendFrame(frame, bypassQueue);
	}
}
