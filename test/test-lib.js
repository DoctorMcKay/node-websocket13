// This is a very simple test, mostly just to make sure that things work under various Node.js versions.

const {createServer} = require('http');
const {WebSocketServer, WebSocket, FrameType} = require('websocket13');

let httpSrv = createServer((req, res) => {
	res.writeHead(404, {'Content-Type': 'text/plain'});
	res.end('404');
});

let wsSrv = new WebSocketServer();
wsSrv.http(httpSrv);

httpSrv.listen(8080, onHttpListening);

wsSrv.on('handshake', (handshakeData, reject, accept) => {
	console.log(`Incoming handshake from ${handshakeData.remoteAddress}`);
	let ws = accept();

	ws.send('SERVER HELLO');

	ws.on('message', (type, data) => {
		console.log(`Server RX: ${data}`);
	});

	ws.on('disconnected', (code, reason) => {
		console.log(`Server client disconnected: ${code} (${reason})`);
		process.exit(0);
	});
});

function onHttpListening() {
	let client = new WebSocket('ws://127.0.0.1:8080');
	client.on('connected', () => {
		console.log('Client connected');
		client.send('CLIENT HELLO');

		let stream = client.createMessageStream(FrameType.Data.Text);
		stream.write('Chunk 1 ');
		setTimeout(() => stream.write('Chunk 2 '), 100);
		setTimeout(() => stream.write('Chunk 3 '), 200);
		setTimeout(() => stream.end(), 300);
		setTimeout(() => client.disconnect(1000, 'It worked!'), 500);
	});

	client.on('message', (type, data) => {
		console.log(`Client RX: ${data}`);
	});
}
