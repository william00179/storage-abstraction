import fs from "fs";
import path from "path";
import slugify from "slugify";
import { zip } from "ramda";
import to from "await-to-js";
import { Readable } from "stream";
import B2 from "backblaze-b2";
// require("@gideo-llc/backblaze-b2-upload-any").install(B2);
import { AbstractStorage } from "./AbstractStorage";
import { IStorage } from "./types";
import { parseUrlGeneric } from "./util";

export type ConfigBackBlazeB2 = {
  options?: { [id: string]: string };
  applicationKeyId: string;
  applicationKey: string;
};

export type BackBlazeB2Bucket = {
  accountId: "string";
  bucketId: "string";
  bucketInfo: "object";
  bucketName: "string";
  bucketType: "string";
  corsRules: string[];
  lifecycleRules: string[];
  options: string[];
  revision: number;
};

export type BackBlazeB2File = {
  accountId: string;
  action: string;
  bucketId: string;
  contentLength: number;
  contentMd5: string;
  contentSha1: string;
  contentType: string;
  fileId: string;
  fileInfo: [object];
  fileName: string;
  uploadTimestamp: number;
};

export class StorageBackBlazeB2 implements IStorage {
  protected type = "b2";
  private storage: B2;
  private initialized = false;
  private buckets: BackBlazeB2Bucket[] = [];
  private files: BackBlazeB2File[] = [];
  private bucketId: string;
  private bucketName: string;
  private nextFileName: string;

  constructor(config: string | ConfigBackBlazeB2) {
    const { applicationKey, applicationKeyId, options } = this.parseConfig(config);
    this.storage = new B2({ applicationKey, applicationKeyId });
    this.bucketName = options.bucketName;
  }

  introspect(): string {
    return "remove this function from interface!";
  }

  public async init(): Promise<boolean> {
    if (this.initialized) {
      return Promise.resolve(true);
    }
    try {
      await this.storage.authorize();
    } catch (e) {
      throw new Error(e.message);
    }
    if (this.bucketName)
      try {
        const {
          data: { buckets },
        } = await this.storage.getBucket({ bucketName: this.bucketName });
        this.buckets = buckets;
        this.getBucketId();
      } catch (e) {
        throw new Error(e.message);
      }
    return true;
  }

  public async test(): Promise<string> {
    if (this.initialized === false) {
      return Promise.reject("storage has not been initialized yet; call Storage.init() first");
    }
    try {
      await this.storage.listBuckets();
    } catch (e) {
      throw new Error(e.message);
    }
    return Promise.resolve("ok");
  }

  private parseConfig(config: string | ConfigBackBlazeB2): ConfigBackBlazeB2 {
    if (typeof config === "string") {
      const [type, applicationKeyId, applicationKey, options] = parseUrlGeneric(config);
      if (type !== this.type) {
        throw new Error(`expecting type "${this.type}" but found type "${type}"`);
      }
      return {
        applicationKeyId,
        applicationKey,
        options,
      };
    }
    return config;
  }

  private getBucketId(): void {
    const index = this.buckets.findIndex(
      (b: BackBlazeB2Bucket) => b.bucketName === this.bucketName
    );
    if (index !== -1) {
      this.bucketId = this.buckets[index].bucketId;
    }
  }

  async getFileAsReadable(
    fileName: string,
    options: { start?: number; end?: number } = { start: 0 }
  ): Promise<Readable> {
    const file = this.storage.bucket(this.bucketName).file(fileName);
    const [exists] = await file.exists();
    if (exists) {
      return file.createReadStream(options);
    }
    throw new Error(`File ${fileName} could not be retrieved from bucket ${this.bucketName}`);
  }

  // not in use
  async downloadFile(fileName: string, downloadPath: string): Promise<void> {
    const file = this.storage.bucket(this.bucketName).file(fileName);
    const localFilename = path.join(downloadPath, fileName);
    await file.download({ destination: localFilename });
  }

  async removeFile(fileName: string): Promise<void> {
    try {
      await this.storage
        .bucket(this.bucketName)
        .file(fileName)
        .delete();
    } catch (e) {
      if (e.message.indexOf("No such object") !== -1) {
        return;
      }
      // console.log(e.message);
      throw e;
    }
  }

  async addFileFromPath(origPath: string, targetPath: string): Promise<void> {
    const paths = targetPath.split("/").map(d => slugify(d));
    await this.store(origPath, path.join(...paths));
  }

  async addFileFromBuffer(buffer: Buffer, targetPath: string): Promise<void> {
    const paths = targetPath.split("/").map(d => slugify(d));
    await this.store(buffer, path.join(...paths));
  }

  async addFileFromReadable(stream: Readable, targetPath: string): Promise<void> {
    const paths = targetPath.split("/").map(d => slugify(d));
    await this.store(stream, path.join(...paths));
  }

  protected checkBucket(name: string): boolean {
    return this.buckets.findIndex(b => b.bucketName === name) !== -1;
  }

  public getSelectedBucket(): string | null {
    return this.bucketName;
  }

  // util members

  protected async store(buffer: Buffer, targetPath: string): Promise<void>;
  protected async store(stream: Readable, targetPath: string): Promise<void>;
  protected async store(origPath: string, targetPath: string): Promise<void>;
  protected async store(arg: string | Buffer | Readable, targetPath: string): Promise<void> {
    if (this.bucketName === null) {
      throw new Error("Please select a bucket first");
    }
    await this.createBucket(this.bucketName);

    let readStream: Readable;
    if (typeof arg === "string") {
      await fs.promises.stat(arg); // throws error if path doesn't exist
      readStream = fs.createReadStream(arg);
    } else if (arg instanceof Buffer) {
      readStream = new Readable();
      readStream._read = (): void => {}; // _read is required but you can noop it
      readStream.push(arg);
      readStream.push(null);
    } else if (arg instanceof Readable) {
      readStream = arg;
    }
    const writeStream = this.storage
      .bucket(this.bucketName)
      .file(targetPath)
      .createWriteStream();
    return new Promise((resolve, reject) => {
      readStream
        .pipe(writeStream)
        .on("error", reject)
        .on("finish", resolve);
      writeStream.on("error", reject);
    });
  }

  async createBucket(name: string): Promise<void> {
    if (name === null) {
      throw new Error("Can not use `null` as bucket name");
    }
    const n = slugify(name);
    if (this.checkBucket(n)) {
      return;
    }
    const bucket = this.storage.bucket(n);
    const [exists] = await bucket.exists();
    if (exists) {
      return;
    }

    try {
      await this.storage.createBucket(n);
      // this.buckets.push(n);
    } catch (e) {
      if (e.code === 409) {
        // error code 409 is 'You already own this bucket. Please select another name.'
        // so we can safely return true if this error occurs
        return;
      }
      throw new Error(e.message);
    }
  }

  async selectBucket(name: string | null): Promise<void> {
    if (name === null) {
      this.bucketName = null;
      return;
    }

    const [error] = await to(this.createBucket(name));
    if (error !== null) {
      throw error;
    }
    this.bucketName = name;
  }

  async clearBucket(name?: string): Promise<void> {
    let n = name || this.bucketName;
    n = slugify(n);
    await this.storage.bucket(n).deleteFiles({ force: true });
  }

  async deleteBucket(name?: string): Promise<void> {
    let n = name || this.bucketName;
    n = slugify(n);
    await this.clearBucket(n);
    const data = await this.storage.bucket(n).delete();
    // console.log(data);
    if (n === this.bucketName) {
      this.bucketName = null;
    }
    this.buckets = this.buckets.filter(b => b.bucketName !== n);
  }

  async listBuckets(): Promise<string[]> {
    const {
      data: { buckets },
    } = await this.storage.listBuckets();
    // this.bucketsById = buckets.reduce((acc: { [id: string]: string }, val: BackBlazeB2Bucket) => {
    //   acc[val.bucketId] = val.bucketName;
    //   return acc;
    // }, {});
    this.buckets = buckets;
    return this.buckets.map(b => b.bucketName);
  }

  private async getMetaData(files: string[]): Promise<number[]> {
    const sizes: number[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = this.storage.bucket(this.bucketName).file(files[i]);
      const [metadata] = await file.getMetadata();
      // console.log(metadata);
      sizes.push(parseInt(metadata.size, 10));
    }
    return sizes;
  }

  async listFiles(numFiles: number = 1000): Promise<[string, number][]> {
    if (this.bucketName === null) {
      throw new Error("Please select a bucket first");
    }
    const {
      data: { files, nextFileName },
    } = await this.storage.listFileNames({
      bucketId: this.bucketId,
    });
    this.files = files;
    this.nextFileName = nextFileName;
    return this.files.map(f => [f.fileName, f.contentLength]);
  }

  async sizeOf(name: string): Promise<number> {
    if (this.bucketName === null) {
      throw new Error("Please select a bucket first");
    }
    const file = this.storage.bucket(this.bucketName).file(name);
    const [metadata] = await file.getMetadata();
    return parseInt(metadata.size, 10);
  }
}
