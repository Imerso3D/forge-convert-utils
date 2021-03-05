/*
 * Example: converting an SVF (without property database) from local file system.
 * Usage:
 *     node local-svf-to-obj.js <path to svf file> <path to output folder>
 */

const path = require('path');
const { SvfReader, ObjWriter } = require('..');

async function run (filepath, outputDir, idFile) {
    const defaultOptions = {
        skipNormals: false,
        log: console.log
    };

    try {
        console.time("read svf")
        const reader = await SvfReader.FromFileSystem(filepath);
        const scene = await reader.read();
        console.timeEnd("read svf")

        const propdb = await reader.getPropertyDb();

        console.time("write obj")
        let writer;
        writer = new ObjWriter(Object.assign({}, defaultOptions));
        await writer.write(scene, outputDir, propdb);
        console.timeEnd("write obj")

    } catch(err) {
        console.error(err);
        process.exit(1);
    }
}

run(process.argv[2], process.argv[3], process.argv[4]);
