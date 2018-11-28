const config = require('config');
const path = require('path');
const { Client } = require('linshare-api-client');

const Files = require('../lib/files');
const { generateToken } = require('./jwt');
const { DOCUMENT_STATES } = require('./constants');
const {
  createDirectory,
  deleteFile,
  existsSync,
  getFileType,
  getFileExtension,
  writeFile
} = require('./helpers');

const STORAGE_DIR = path.join(__dirname, '../../files');

class Document {
  constructor(documentUuid, workGroupUuid, userEmail) {
    this.uuid = documentUuid;
    this.workGroup = workGroupUuid;
    this.filePath = path.join(STORAGE_DIR, this.uuid);
    this.storageService = new Client({
      baseUrl: config.get('linshare.baseUrl'),
      auth: {
        type: 'jwt',
        token: generateToken({ sub: userEmail })
      }
    }).user.workgroup;

    createDirectory(STORAGE_DIR);
  }

  async populateMetadata() {
    const document = await this.storageService.getNode(this.workGroup, this.uuid);

    document.fileType = getFileExtension(document.name);
    document.documentType = getFileType(document.name);

    Object.assign(this, document);
  }

  async save() {
    try {
      await this.setState(DOCUMENT_STATES.downloading);

      const fileData = await this.storageService.downloadDocument(this.workGroup, this.uuid, {
        responseType: 'arrayBuffer'
      });

      await writeFile(this.filePath, fileData);
      await this.setState(DOCUMENT_STATES.downloaded);
    } catch (error) {
      await this.remove();

      throw error;
    }
  }

  async loadState() {
    const document = await Files.getByUuid(this.uuid);

    if (document) {
      this.state = document.state;
    }
  }

  async setState(state) {
    this.state = state;

    const document = await Files.getByUuid(this.uuid);

    if (document) {
      await Files.updateByUuid(this.uuid, { state });
    } else {
      await Files.create(this);
    }
  }

  async remove() {
    await Files.removeByUuid(this.uuid);
    await deleteFile(this.filePath);
  }

  denormalize() {
    const denormalized = { ...this };

    delete denormalized.filePath;

    return denormalized;
  }

  isDownloaded() {
    return existsSync(this.filePath) && this.state === DOCUMENT_STATES.downloaded;
  }

  isDownloading() {
    return this.state === DOCUMENT_STATES.downloading;
  }
}

module.exports = Document;
