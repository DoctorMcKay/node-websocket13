// This can't be a TS enum because we need to maintain backwards compatibility with previous public API

export default {
	Continuation: 0x0,

	Data: {
		Text: 0x1,
		Binary: 0x2
	},

	Control: {
		Close: 0x8,
		Ping: 0x9,
		Pong: 0xa
	}
};
