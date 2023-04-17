import ByteBuffer from 'bytebuffer';
import {Writable} from 'stream';

import FrameType from '../enums/FrameType';
import WebSocketBase from '../WebSocketBase';

export default class StreamedOutgoingMessage extends Writable {
	started: boolean;
	finished: boolean;
	dataSent: boolean;
	type: number; // opcode

	_socket: WebSocketBase;
	_chunks: { payload: Buffer, callback: (Error?) => void }[];

	constructor(socket: WebSocketBase, type: number) {
		super();

		this.started = false;
		this.finished = false;
		this.dataSent = false;
		this.type = type;
		this._socket = socket;
		this._chunks = [];

		this.on('finish', () => {
			this.finished = true;
			this._emptyQueue();
		});

		// @ts-ignore
		this.setDefaultEncoding('binary');
	}

	_start(): void {
		if (this.started) {
			return;
		}

		this.started = true;

		for (let i = 0; i < this._chunks.length; i++) {
			if (this._chunks[i].callback) {
				this._chunks[i].callback(null);
				this._chunks[i].callback = null;
			}
		}

		this._emptyQueue();
	}

	_emptyQueue(): void {
		if (!this.started || this._chunks.length == 0) {
			return;
		}

		let chunks = this._chunks.slice(0, this.finished ? this._chunks.length : this._chunks.length - 1);
		if (chunks.length == 0) {
			return;
		}

		// No reason not to combine all those chunks into one
		let buffer = Buffer.concat(chunks.map(chunk => chunk.payload));
		this._socket._sendFrame({
			FIN: !!this.finished,
			RSV1: false,
			RSV2: false,
			RSV3: false,
			opcode: !this.dataSent ? this.type : FrameType.Continuation,
			payloadLength: buffer.length,
			payload: buffer
		}, true);

		this.dataSent = true;

		chunks.filter(chunk => !!chunk.callback).forEach(chunk => chunk.callback(null));
		this._chunks.splice(0, chunks.length);

		this._socket._processQueue();
	}

	_write(chunk, encoding, callback): void {
		if (this.type == FrameType.Data.Binary && typeof chunk === 'string') {
			callback(new Error('Cannot send a string through a binary frame.'));
			this.end();
			return;
		}

		if (ByteBuffer.isByteBuffer(chunk)) {
			chunk = chunk.toBuffer();
		}

		// We have to call the callback now or else remaining chunks don't make their way to us
		if (this.started) {
			callback(null);
		}

		this._chunks.push({
			payload: chunk,
			callback: !this.started ? callback : null
		});

		this._emptyQueue();
		this._socket._processQueue();
	}
}
