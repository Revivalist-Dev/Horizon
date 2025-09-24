import Axios from 'axios';
import { Connection } from './interfaces';
import core from '../chat/core'; // Assuming core is accessible for settings later
import log from 'electron-log'; // Import electron-log
import * as fs from 'fs';
import * as path from 'path';
import { GeneralSettings } from '../electron/common'; // Import GeneralSettings

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
  private fchatUserName: string | undefined;
  private sillyTavernApiUrl: string | undefined;
  private fListPassword: string | undefined;
  private ensuredSillyTavernCharacters: Map<string, boolean> = new Map(); // Track ensured characters

  constructor(
    private connection: Connection,
    private generalSettings: GeneralSettings
  ) {
    this.sillyTavernApiUrl = generalSettings.sillyTavernApiUrl;
    this.fListPassword = generalSettings.sillyTavernFListPassword;
  }

  private getCleanApiUrl(): string | undefined {
    if (!this.sillyTavernApiUrl) {
      return undefined;
    }
    return this.sillyTavernApiUrl.endsWith('/')
      ? this.sillyTavernApiUrl.slice(0, -1)
      : this.sillyTavernApiUrl;
  }

  async init(): Promise<void> {
    log.info('SillyTavernBridge.init() called.');
    log.info('SillyTavernBridge initialized.');

    // Add Axios interceptors for detailed logging
    axiosInstance.interceptors.request.use(request => {
      log.debug('Axios Request:', {
        method: request.method,
        url: request.url,
        headers: request.headers,
        data: request.data
      });
      return request;
    });

    axiosInstance.interceptors.response.use(
      response => {
        log.debug('Axios Response:', {
          status: response.status,
          statusText: response.statusText,
          data: response.data,
          config: response.config
        });
        return response;
      },
      error => {
        log.error('Axios Response Error:', {
          message: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          config: error.config
        });
        return Promise.reject(error);
      }
    );

    this.connection.onEvent('connected', async () => {
      this.fchatUserName = core.connection.character;
      log.info(`F-Chat connected as ${this.fchatUserName}.`);
      log.info(
        'SillyTavern CSRF protection is disabled. Skipping CSRF token fetch and login attempt.'
      );
      log.info('SillyTavern bridge ready to process messages.');
    });

    this.connection.onMessage('MSG', this.handleChannelMessage.bind(this));
    this.connection.onMessage('PRI', this.handlePrivateMessage.bind(this));
  }

  private async handleChannelMessage(
    data: Connection.ServerCommands['MSG'],
    time: Date
  ): Promise<void> {
    log.info('F-Chat Channel Message Received:', data);
    const sillyTavernCharacterName = this.getSillyTavernCharacterName(
      data.channel
    );
    const sillyTavernChatFileName = this.getSillyTavernChatFileName(
      data.channel
    );

    await this.ensureSillyTavernCharacterAndChatExists(
      sillyTavernCharacterName,
      sillyTavernChatFileName
    );

    const message: SillyTavernMessage = {
      name:
        data.character === this.fchatUserName
          ? this.fchatUserName
          : sillyTavernCharacterName,
      is_user: data.character === this.fchatUserName,
      send_date: time.toISOString(),
      mes:
        data.character === this.fchatUserName
          ? data.message
          : `${data.character}: ${data.message}`
    };
    await this.sendToSillyTavern(
      sillyTavernCharacterName,
      sillyTavernChatFileName,
      message
    );
  }

  private async handlePrivateMessage(
    data: Connection.ServerCommands['PRI'],
    time: Date
  ): Promise<void> {
    log.info('F-Chat Private Message Received:', data);
    // For private messages, we'll use the other character's name as the SillyTavern character name
    // and a fixed chat file name.
    const otherCharacterName = data.character;
    const sillyTavernCharacterName = this.getSillyTavernCharacterName(
      `PM_with_${otherCharacterName}`
    );
    const sillyTavernChatFileName = this.getSillyTavernChatFileName(
      `PM_with_${otherCharacterName}`
    );

    await this.ensureSillyTavernCharacterAndChatExists(
      sillyTavernCharacterName,
      sillyTavernChatFileName
    );

    const message: SillyTavernMessage = {
      name:
        data.character === this.fchatUserName
          ? this.fchatUserName
          : sillyTavernCharacterName,
      is_user: data.character === this.fchatUserName,
      send_date: time.toISOString(),
      mes:
        data.character === this.fchatUserName
          ? data.message
          : `${data.character}: ${data.message}`
    };
    await this.sendToSillyTavern(
      sillyTavernCharacterName,
      sillyTavernChatFileName,
      message
    );
  }

  private getSillyTavernCharacterName(fchatIdentifier: string): string {
    // Sanitize the F-Chat identifier to be a valid filename for SillyTavern character
    return fchatIdentifier.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private getSillyTavernChatFileName(fchatIdentifier: string): string {
    // For now, we'll use a fixed chat file name per channel/PM.
    // If multiple conversations per channel are desired, this would need to be more dynamic.
    return this.getSillyTavernCharacterName(fchatIdentifier); // Use the sanitized identifier as the chat file name
  }

  private async ensureSillyTavernCharacterAndChatExists(
    characterName: string,
    chatFileName: string
  ): Promise<void> {
    if (this.ensuredSillyTavernCharacters.has(characterName)) {
      return; // Already ensured for this session
    }

    const sillyTavernDataPath = path.join(
      process.cwd(),
      '.SillyTavern',
      'data',
      'default-user'
    );
    const charactersPath = path.join(sillyTavernDataPath, 'characters');
    const characterFilePath = path.join(
      charactersPath,
      `${characterName}.json`
    );
    const chatDirectoryPath = path.join(
      sillyTavernDataPath,
      'chats',
      characterName
    );
    const chatFilePath = path.join(chatDirectoryPath, `${chatFileName}.jsonl`);

    try {
      // Ensure the characters directory exists
      if (!fs.existsSync(charactersPath)) {
        await fs.promises.mkdir(charactersPath, { recursive: true });
        log.info(`Created SillyTavern characters directory: ${charactersPath}`);
      }

      // Check if the character file exists, create if not
      if (!fs.existsSync(characterFilePath)) {
        const defaultCharacterData = {
          name: characterName,
          description: `F-Chat logs for ${characterName}`,
          creator: 'F-Chat Horizon Bridge',
          avatar: `${characterName}.png` // Assuming a default avatar image named after the character
        };
        await fs.promises.writeFile(
          characterFilePath,
          JSON.stringify(defaultCharacterData, null, 2)
        );
        log.info(
          `Created SillyTavern character file for "${characterName}" at ${characterFilePath}. Please refresh the SillyTavern UI to see the new character.`
        );
      } else {
        log.debug(
          `SillyTavern character file for "${characterName}" already exists.`
        );
      }

      // Ensure the chat directory exists
      if (!fs.existsSync(chatDirectoryPath)) {
        await fs.promises.mkdir(chatDirectoryPath, { recursive: true });
        log.info(
          `Created SillyTavern chat directory for "${characterName}": ${chatDirectoryPath}`
        );
      }

      // If the chat file doesn't exist, create an empty one with a header
      if (!fs.existsSync(chatFilePath)) {
        if (!this.fchatUserName) {
          log.error(
            'F-Chat user name not set. Cannot create chat header for new chat file.'
          );
          return;
        }
        const header: SillyTavernChatHeader = {
          user_name: this.fchatUserName,
          character_name: characterName,
          create_date: new Date().toISOString()
        };
        await fs.promises.writeFile(
          chatFilePath,
          JSON.stringify(header) + '\n'
        );
        log.info(
          `Created new SillyTavern chat file for "${characterName}" at ${chatFilePath}.`
        );
      } else {
        log.debug(
          `SillyTavern chat file for "${characterName}" already exists.`
        );
      }

      this.ensuredSillyTavernCharacters.set(characterName, true);
    } catch (error) {
      log.error(
        `Error ensuring SillyTavern character and chat for "${characterName}" exists:`,
        error
      );
    }
  }

  private async sendToSillyTavern(
    sillyTavernCharacterName: string,
    sillyTavernChatFileName: string,
    newMessage: SillyTavernMessage
  ): Promise<void> {
    try {
      if (!this.sillyTavernApiUrl) {
        log.error('SillyTavern API URL not set. Cannot send message.');
        return;
      }
      log.debug(
        `Attempting to send message to SillyTavern API at: ${this.sillyTavernApiUrl}`
      );

      const apiUrl = this.getCleanApiUrl();

      // 1. Fetch existing chat data
      const getResponse = await axiosInstance.post(`${apiUrl}/api/chats/get`, {
        avatar_url: `${sillyTavernCharacterName}.png`,
        file_name: sillyTavernChatFileName
      });

      let existingChat: (SillyTavernChatHeader | SillyTavernMessage)[] = [];
      if (getResponse.data && Array.isArray(getResponse.data)) {
        existingChat = getResponse.data;
      }

      // Ensure the chat header exists (should be handled by ensureSillyTavernCharacterAndChatExists, but as a fallback)
      if (existingChat.length === 0 || !('user_name' in existingChat)) {
        if (!this.fchatUserName) {
          log.error('F-Chat user name not set. Cannot create chat header.');
          return;
        }
        const header: SillyTavernChatHeader = {
          user_name: this.fchatUserName,
          character_name: sillyTavernCharacterName,
          create_date: new Date().toISOString()
        };
        existingChat.unshift(header);
      }

      // 2. Append new message
      existingChat.push(newMessage);

      // 3. Save the updated chat data
      const saveResponse = await axiosInstance.post(
        `${apiUrl}/api/chats/save`,
        {
          avatar_url: `${sillyTavernCharacterName}.png`,
          file_name: sillyTavernChatFileName,
          chat: existingChat,
          force: true // Bypass integrity check
        }
      );

      if (saveResponse.data.result === 'ok') {
        log.info(
          `Message successfully sent to SillyTavern for character "${sillyTavernCharacterName}" and chat "${sillyTavernChatFileName}".`
        );
      } else {
        log.error('Failed to send message to SillyTavern:', saveResponse.data);
      }
    } catch (error) {
      log.error(
        'Error sending message to SillyTavern:',
        Axios.isAxiosError(error) ? error.response?.data : error
      );
    }
  }
}
