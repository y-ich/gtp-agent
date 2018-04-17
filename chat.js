/* global exports */
const DDPClient = require('ddp-plus');

const CHAT_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

const chat = {
    chatServer: null,
    rooms: new Set(),
    enableChat(roomId) {
        if (!this.chatServer) {
            this.chatServer = new DDPClient({ url: CHAT_SERVER });
            this.chatServer.connect();
        }
        this.rooms.add(roomId);
    },

    disableChat(roomId) {
        this.rooms.delete(roomId);
        if (this.rooms.size === 0 && this.charServer) {
            this.chatServer.close();
            this.chatServer = null;
        }
    },

    async chat(roomId, user, message, lang) {
        if (!this.chatServer) {
            console.log('has not connected with chatServer yet', message);
            return;
        }
        await this.chatServer.call('chat', ['twiigo', roomId, null, {
            id: user._id,
            name: user.profile.name,
            lang,
            gender: user.profile.gender
        }, message]);
    }
}

exports.chat = chat;
