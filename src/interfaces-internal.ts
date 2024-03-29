import {HandshakeData, WebSocketClientConnectionOptions} from './interfaces-external';
import StreamedIncomingMessage from './streams/StreamedIncomingMessage';
import WebSocketServerConnection from './WebSocketServerConnection';

export interface WebSocketEvents {
	connected: (args: WebSocketConnectEventArgs) => void,
	connect: (args: WebSocketConnectEventArgs) => void,
	disconnected: (code: number, reason: string, initiatedByUs: boolean) => void,
	disconnect: (code: number, reason: string, initiatedByUs: boolean) => void,
	error: (err: Error) => void,
	message: (type: number, data: string|Buffer) => void,
	streamedMessage: (type: number, stream: StreamedIncomingMessage) => void,
	latency: (pingTimeMilliseconds: number) => void,
	timeout: () => void,
	debug: (msg: string) => void
}

export interface WebSocketConnectEventArgs {
	headers: {[name: string]: string},
	httpVersion: string,
	responseCode: number,
	responseText: string
}

export interface WebSocketServerEvents {
	handshake: (
		handshakeData: HandshakeData,
		reject: (statusCode?: number, body?: string|object, headers?: {[name: string]: string|number}) => void,
		accept: (response?: {
			headers?: {[name: string]: string|number},
			protocol?: string,
			options?: BaseWebSocketOptions,
			permessageDeflate?: boolean
		}) => WebSocketServerConnection
	) => void,
	connection: (socket: WebSocketServerConnection) => void
}

export interface BaseWebSocketOptions {
	pingInterval?: number;
	pingTimeout?: number;
	pingFailures?: number;
	protocols?: string[];
	permessageDeflate?: boolean;
}

export interface WebSocketClientConnectionOptionsInternal extends WebSocketClientConnectionOptions {
	headers?: {[name: string]: string|number};
	protocol: string;
	port: number;
}

export interface TxStats {
	wire: number;
	preExt: number;
}

export interface RxStats {
	wire: number;
	postExt: number;
}

export interface WebSocketStats {
	tx: TxStats;
	rx: RxStats;
}

export interface WsFrame {
	FIN: boolean;
	RSV1: boolean;
	RSV2: boolean;
	RSV3: boolean;
	opcode: number;
	payloadLength: number;
	maskKey?: number;
	payload: Buffer;
}

export interface WsExtensionFrame {
	final: boolean;
	rsv1: boolean;
	rsv2: boolean;
	rsv3: boolean;
	opcode: number;
	masked: boolean;
	maskingKey: number;
	payload: Buffer;
}

export interface WsExtensionMessage {
	rsv1: boolean;
	rsv2: boolean;
	rsv3: boolean;
	opcode: number;
	data: Buffer;
}
