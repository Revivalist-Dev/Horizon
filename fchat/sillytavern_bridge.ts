import Axios from 'axios';
import { Connection } from './interfaces';
import core from '../chat/core'; // Assuming core is accessible for settings later
import log from 'electron-log'; // Import electron-log

// Configure Axios to handle cookies
const axiosInstance = Axios.create({
    withCredentials: true // This is crucial for sending and receiving cookies
});

interface SillyTavernMessage {
    name: string;
    is_user: boolean;
    send_date: string; // ISO 8601
    mes: string;
}

interface SillyTavernChatHeader {
    user_name: string;
    character_name: string;
    create_date: string; // ISO 8601
    chat_metadata?: {
        integrity: string;
    };
}

export class SillyTavernBridge {
    private sillyTavernApiUrl = 'http://localhost:8000'; // Placeholder - MUST BE CONFIGURED
    private targetCharacterName = 'F-Chat Logs';
    private fchatUserName = 'Derby Falcon';
    private currentChatFileName: string | undefined;
    private csrfToken: string | undefined;
    private fListAccount: string | undefined; // To store F-List account name
    private fListPassword: string = 'Shinrinpaku2242!'; // Set F-List password

    constructor(private connection: Connection) {}

    async init(): Promise<void> {
        log.info('SillyTavernBridge.init() called.');
        log.info('SillyTavernBridge initialized.');
        log.info('Attempting to fetch CSRF token...');
        await this.fetchCsrfToken();
        log.info('CSRF token fetch attempt completed.');

        this.connection.onEvent('connected', async () => {
            this.fListAccount = core.connection.character; // Set F-List account name when connected
            log.info('F-Chat connected. Attempting to log in to SillyTavern...');
            await this.loginToSillyTavern();
            log.info('SillyTavern login attempt completed.');
        });

        this.connection.onMessage('MSG', this.handleChannelMessage.bind(this));
        this.connection.onMessage('PRI', this.handlePrivateMessage.bind(this));
    }

    private async handleChannelMessage(data: Connection.ServerCommands['MSG'], time: Date): Promise<void> {
        log.info('F-Chat Channel Message Received:', data);
        // Implement logic to filter messages by channel if needed
        // For now, let's just forward all channel messages
        const message: SillyTavernMessage = {
            name: data.character,
            is_user: data.character === this.fchatUserName, // Assuming F-Chat user is 'F-Chat User'
            send_date: time.toISOString(),
            mes: data.message
        };
        await this.sendToSillyTavern(message);
    }

    private async handlePrivateMessage(data: Connection.ServerCommands['PRI'], time: Date): Promise<void> {
        log.info('F-Chat Private Message Received:', data);
        // Implement logic to filter messages by recipient if needed
        const message: SillyTavernMessage = {
            name: data.character,
            is_user: data.character === this.fchatUserName, // Assuming F-Chat user is 'F-Chat User'
            send_date: time.toISOString(),
            mes: data.message
        };
        await this.sendToSillyTavern(message);
    }

    private async sendToSillyTavern(newMessage: SillyTavernMessage): Promise<void> {
        try {
            if (!this.currentChatFileName) {
                this.currentChatFileName = await this.getLatestChatFileName();
                if (!this.currentChatFileName) {
                    log.error('Could not determine current SillyTavern chat file name.');
                    return;
                }
            }

            const chatFileNameWithoutExtension = this.currentChatFileName.replace('.jsonl', '');

            // 1. Fetch existing chat data
            const getResponse = await axiosInstance.post(`${this.sillyTavernApiUrl}/api/get`, {
                avatar_url: `${this.targetCharacterName}.png`,
                file_name: chatFileNameWithoutExtension
            }, {
                headers: { 'X-CSRF-Token': this.csrfToken }
            });

            let existingChat: (SillyTavernChatHeader | SillyTavernMessage)[] = [];
            if (getResponse.data && Array.isArray(getResponse.data)) {
                existingChat = getResponse.data;
            }

            // Ensure the chat header exists
            if (existingChat.length === 0 || !('user_name' in existingChat)) {
                const header: SillyTavernChatHeader = {
                    user_name: this.fchatUserName,
                    character_name: this.targetCharacterName,
                    create_date: new Date().toISOString()
                };
                existingChat.unshift(header);
            }

            // 2. Append new message
            existingChat.push(newMessage);

            // 3. Save the updated chat data
            const saveResponse = await axiosInstance.post(`${this.sillyTavernApiUrl}/api/save`, {
                avatar_url: `${this.targetCharacterName}.png`,
                file_name: chatFileNameWithoutExtension,
                chat: existingChat
            }, {
                headers: { 'X-CSRF-Token': this.csrfToken }
            });

            if (saveResponse.data.result === 'ok') {
                log.info('Message successfully sent to SillyTavern.');
            } else {
                log.error('Failed to send message to SillyTavern:', saveResponse.data);
            }
        } catch (error) {
            log.error('Error sending message to SillyTavern:', Axios.isAxiosError(error) ? error.response?.data : error);
        }
    }

    private async getLatestChatFileName(): Promise<string | undefined> {
        try {
            const response = await axiosInstance.post(`${this.sillyTavernApiUrl}/api/recent`, {
                avatar: `${this.targetCharacterName}.png`,
                max: 1 // Get only the most recent
            }, {
                headers: { 'X-CSRF-Token': this.csrfToken }
            });

            if (response.data && Array.isArray(response.data) && response.data.length > 0) {
                // The /recent endpoint returns an array of chat infos, sorted by mtime descending.
                // The first element should be the most recent.
                return response.data[0].file_name;

 // Corrected access
            }
        } catch (error) {
            log.error('Error fetching recent chat files from SillyTavern:', Axios.isAxiosError(error) ? error.response?.data : error);
        }
        return undefined;
    }

    private async fetchCsrfToken(): Promise<void> {
        try {
            const response = await axiosInstance.get(`${this.sillyTavernApiUrl}/csrf-token`);
            if (response.data && response.data.token) {
                this.csrfToken = response.data.token;
                log.info('CSRF token fetched successfully:', this.csrfToken);
            } else {
                log.error('Failed to fetch CSRF token: Token not found in response.', response.data);
            }
        } catch (error) {
            log.error('Error fetching CSRF token:', Axios.isAxiosError(error) ? error.response?.data : error);
        }
    }

    private async loginToSillyTavern(): Promise<void> {
        if (!this.fListAccount) {
            log.error('F-List account not available for SillyTavern login.');
            return;
        }

        if (!this.fListPassword) {
            // This should be prompted from the user or retrieved securely
            log.error('SillyTavern password (F-List password) not set. Cannot log in.');
            return;
        }

        try {
            const response = await axiosInstance.post(`${this.sillyTavernApiUrl}/api/users/login`, {
                handle: this.fListAccount,
                password: this.fListPassword
            }, {
                headers: { 'X-CSRF-Token': this.csrfToken }
            });

            if (response.data && response.data.handle) {
                log.info(`Successfully logged into SillyTavern as ${response.data.handle}.`);
            } else {
                log.error('Failed to log into SillyTavern: Invalid credentials or unexpected response.', response.data);
            }
        } catch (error) {
            log.error('Error logging into SillyTavern:', Axios.isAxiosError(error) ? error.response?.data : error);
        }
    }
}