const config = require('config');
const path = require('path');
const uuidV4 = require('uuid/v4');

const pubsub = require('../lib/pubsub');
const Files = require('../lib/files');
const { generateToken } = require('./jwt');
const { DOCUMENT_STATES, EDITABLE_EXTENSIONS, PUBSUB_EVENTS } = require('./constants');
const {
  createDirectory,
  deleteFile,
  existsSync,
  getFileType,
  getFileExtension,
  writeFile,
  createLinshareClient,
  verifyUserEditPermission
} = require('./helpers');

const STORAGE_DIR = path.join(__dirname, '../../files');

class Document {
  constructor(documentUuid, workGroupUuid, user) {
    this.uuid = documentUuid;
    this.workGroup = workGroupUuid;
    this.user = user;
    this.filePath = path.join(STORAGE_DIR, this.uuid);

    this.storageService = createLinshareClient({ sub: user.mail }).user.workgroup;

    createDirectory(STORAGE_DIR);
  }

  async populateMetadata() {
    let document;

    try {
      document = await this.storageService.getNode(this.workGroup, this.uuid);
    } catch (error) {
      if (error.response && error.response.status && error.response.status === 404) {
        throw new Error('Document not found');
      }

      throw error;
    }

    document.fileType = getFileExtension(document.name);
    document.documentType = getFileType(document.name);
    if (this.isDownloaded()) {
      document.downloadUrlPath = `/files/${this.uuid}`;
      document.callbackUrlPath = `/api/documents/track?workGroupUuid=${this.workGroup}&documentUuid=${this.uuid}`;
    }

    Object.assign(this, document);
  }

  async update(url) {
    await this.storageService.createDocumentFromUrl(
      this.workGroup,
      { url, fileName: this.name },
      { parent: this.parent, async: false }
    );
  }

  async save() {
    try {
      const fileData = await this.storageService.downloadDocument(this.workGroup, this.uuid, {
        responseType: 'arraybuffer'
      });

      await writeFile(this.filePath, fileData);
      await this.setState(DOCUMENT_STATES.downloaded);
      await this.populateMetadata();

      pubsub.topic(PUBSUB_EVENTS.DOCUMENT_DOWNLOADED).publish(this);
    } catch (error) {
      // TODO: if removing document from db is failed, we cannot open that document anymore. It is always in "downloading" state!!!
      await this.remove();

      pubsub.topic(PUBSUB_EVENTS.DOCUMENT_DOWNLOAD_FAILED).publish({
        document: this,
        error
      });

      throw error;
    }
  }

  async load() {
    const document = await Files.getByUuid(this.uuid);

    if (document) {
      this.state = document.state;
      this.key = document.key;
    }
  }

  async setState(state) {
    this.state = state;

    const document = await Files.getByUuid(this.uuid);

    if (document) {
      await Files.updateByUuid(this.uuid, { state });
    } else {
      this.key = uuidV4(); // Generate key for new document

      await Files.create(this);
    }
  }

  /**
    Currently, the key sent to document server will
    immediately become invalid after document server
    sends a request to callbackUrl along with the status
    of 2 and the edited document download url.

    To avoid users try to access the document using
    the old invalid key while it being saved to Linshare,
    let the user wait until saving is done and new key
    is generated (by set "saving" state for the document).

    This solution does not totally get rid of invalid key
    problem as the user might try to access the document
    by the time document state being updated from "downloaded"
    to "saving". Having said that, this will minimize the
    possibility.

    Read more:
    https://api.onlyoffice.com/editors/troubleshooting#key
    https://github.com/ONLYOFFICE/DocumentServer/issues/513
  */
  async remove() {
    await Files.updateByUuid(this.uuid, { state: DOCUMENT_STATES.removed, key: uuidV4() });
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

  isEditableExtension() {
    return EDITABLE_EXTENSIONS.indexOf(this.fileType) !== -1;
  }

  async canBeEdited() {
    const editPermissionGranted = await verifyUserEditPermission(this.user, this.workGroup);

    return editPermissionGranted;
  }

  buildDocumentserverPayload() {
    const payload = {
      document: {
        fileType: this.fileType,
        title: this.name,
        url: `${config.webserver.baseUrl}${this.downloadUrlPath}`,
        key: this.key
      },
      documentType: this.documentType,
      editorConfig: {
        user: {
          id: this.user.mail,
          name: `${this.user.firstName} ${this.user.lastName}`
        },
        callbackUrl: `${config.webserver.baseUrl}${this.callbackUrlPath}`,
        customization: {
          forcesave: true
        }
      }
    };

    const { enable, secret, algorithm, expiresIn } = config.get('documentServer.signature.browser');

    if (!enable) {
      return payload;
    }

    return {
      ...payload,
      token: generateToken(payload, {
        key: secret,
        algorithm,
        expiresIn
      })
    };
  }
}

module.exports = Document;
