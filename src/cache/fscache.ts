import * as sqlite3 from "sqlite3";
import { sqliteExec, sqliteOpenDatabase, sqlitePrepare, sqliteRunStatement } from "../libs/sqlite3wrap";

const dbpath = "./fscache.sqlite3";

export class FileSourceFsCache {
    ready: Promise<void>;
    isready: boolean;
    database!: sqlite3.Database;
    getstatement!: sqlite3.Statement;
    setstatement!: sqlite3.Statement;

    constructor() {
        this.isready = false;
        this.ready = (async () => {
            let database = await sqliteOpenDatabase(dbpath, { create: true, write: true });

            await sqliteExec(database, `CREATE TABLE IF NOT EXISTS groupcache (major INT, minor INT, crc UNSIGNED INT, file BLOB);`);
            await sqliteExec(database, `CREATE UNIQUE INDEX IF NOT EXISTS mainindex ON groupcache(major,minor,crc)`);

            this.getstatement = await sqlitePrepare(database, `SELECT major, minor, crc, file FROM groupcache WHERE major=? AND minor=? AND crc=?`);
            this.setstatement = await sqlitePrepare(database, `INSERT INTO groupcache(major,minor,crc,file) VALUES (?,?,?,?)`);

            this.isready = true;
        })()
    }

    async addFile(major: number, minor: number, crc: number, file: Buffer) {
        if (!this.isready) {
            await this.ready;
        }
        console.log("setting", major, minor, crc, "len", file.length);
        sqliteRunStatement(this.setstatement, [major, minor, crc, file]);
    }

    async getFile(major: number, minor: number, crc: number): Promise<Buffer | null> {
        if (!this.isready) {
            await this.ready;
        }
        let cached = await sqliteRunStatement(this.getstatement, [major, minor, crc]);
        if (cached.length > 1) {
            throw new Error("more than one match for fs cached file");
        }
        if (cached.length == 1) {
            if (!cached[0].file) {
                throw new Error(`file ${major}.${minor} not found (explicitly missing in cache)`);
            }
            return cached[0].file;
        }
        return null;
    }
}