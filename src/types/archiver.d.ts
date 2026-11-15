/**
 * Tipos mínimos do archiver 8 (o pacote não traz tipos e o @types/archiver cobre só a v6).
 * Na v8 não há mais a função default `archiver('zip')`: usa-se `new ZipArchive(options)`.
 */
declare module 'archiver' {
  import { Transform } from 'stream';

  export interface ArchiverOptions {
    zlib?: { level?: number };
    store?: boolean;
    comment?: string;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    highWaterMark?: number;
  }

  export interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
    prefix?: string;
  }

  export class Archiver extends Transform {
    append(source: NodeJS.ReadableStream | Buffer | string, data: EntryData): this;
    file(filepath: string, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}
