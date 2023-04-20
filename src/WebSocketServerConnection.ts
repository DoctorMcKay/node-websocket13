import WebSocketExtensions from 'websocket-extensions';

import WebSocketBase from './WebSocketBase';
import {Socket} from 'net';
import {TLSSocket} from 'tls';
import {BaseWebSocketOptions} from './interfaces-internal';
import {HandshakeData} from './interfaces-external';
import State from './enums/State';

export default class WebSocketServerConnection extends WebSocketBase {
	handshakeData: HandshakeData;

	constructor(
		socket: Socket|TLSSocket,
		options: BaseWebSocketOptions,
		handshakeData: HandshakeData,
		head: Buffer,
		extensions: WebSocketExtensions
	) {
		super();

		options = options || {};
		Object.assign(this.options, options);

		this.state = State.Connected;
		this.handshakeData = handshakeData;
		this._extensions = extensions;
		this.protocol = handshakeData.selectedProtocol || null;

		this._socket = socket;
		this._type = 'server';

		this._prepSocketEvents();
		if (head && head.length > 0) {
			this._dataBuffer = head; // don't call _handleData just yet, as there are no event listeners bound
		}

		this._onConnected();
	}
}
