var WS13 = require('./index.js');

var Writable = require('stream').Writable;
var ByteBuffer = require('bytebuffer');

module.exports = StreamedOutgoingMessage;

require('util').inherits(StreamedOutgoingMessage, Writable);

function StreamedOutgoingMessage(socket, type) {
	this.started = false;
	this.finished = false;
	this.dataSent = false;
	this.type = type;
	this._socket = socket;
	this._chunks = [];

	Writable.call(this);

	this.on('finish', () => {
		this.finished = true;
		this._emptyQueue();
	});

	this.setDefaultEncoding("binary");
}

StreamedOutgoingMessage.prototype._start = function() {
	if (this.started) {
		return;
	}

	this.started = true;

	for (var i = 0; i < this._chunks.length; i++) {
		if (this._chunks[i].callback) {
			this._chunks[i].callback(null);
			this._chunks[i].callback = null;
		}
	}

	this._emptyQueue();
};

StreamedOutgoingMessage.prototype._emptyQueue = function() {
	if (!this.started || this._chunks.length == 0) {
		return;
	}

	var chunks = this._chunks.slice(0, this.finished ? this._chunks.length : this._chunks.length - 1);
	if (chunks.length == 0) {
		return;
	}

	// No reason not to combine all those chunks into one
	var buffer = Buffer.concat(chunks.map(chunk => chunk.payload));
	this._socket._sendFrame({
		"FIN": !!this.finished,
		"RSV1": false,
		"RSV2": false,
		"RSV3": false,
		"opcode": !this.dataSent ? this.type : WS13.FrameType.Continuation,
		"payload": buffer
	}, true);

	this.dataSent = true;

	chunks.filter(chunk => !!chunk.callback).forEach(chunk => chunk.callback(null));
	this._chunks.splice(0, chunks.length);

	this._socket._processQueue();
};

StreamedOutgoingMessage.prototype._write = function(chunk, encoding, callback) {
	if (this.type == WS13.FrameType.Data.Binary && typeof chunk === 'string') {
		callback(new Error("Cannot send a string through a binary frame."));
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
		"payload": chunk,
		"callback": !this.started ? callback : null
	});

	this._emptyQueue();
	this._socket._processQueue();
};