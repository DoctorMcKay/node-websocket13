import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import {Socket} from 'net';
import {TLSSocket} from 'tls';

import {BaseWebSocketOptions} from './interfaces-internal';

// eslint-disable-next-line
export interface WebSocketServerOptions extends BaseWebSocketOptions {
}

export interface WebSocketClientOptions extends BaseWebSocketOptions {
	headers?: {[name: string]: string|number};
	cookies?: {[name: string]: string};
	connection?: WebSocketClientConnectionOptions;
	handshakeBody?: string;
	httpProxy?: string;
	proxyTimeout?: number;
}

export interface WebSocketClientConnectionOptions {
	localAddress?: string;
	auth?: string;
	agent?: HttpAgent|HttpsAgent;
	pfx?: string|string[]|Buffer|Buffer[]|object[];
	key?: string|string[]|Buffer|Buffer[]|object[];
	passphrase?: string;
	cert?: string|string[]|Buffer|Buffer[];
	ca?: string|string[]|Buffer|Buffer[];
	ciphers?: string;
	rejectUnauthorized?: boolean;
	secureProtocol?: string;
	servername?: string;
}

export interface HandshakeData {
	path: string;
	query: {[name: string]: string};
	headers: {[name: string]: string},
	httpVersion: string;
	origin?: string;
	protocols: string[];
	selectedProtocol?: string;
	auth?: string;
	cookies: {[name: string]: string};
	remoteAddress: string;
	socket: Socket|TLSSocket
}
