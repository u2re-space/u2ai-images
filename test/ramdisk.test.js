import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRamdisk, createRamdiskFileSystem, createSharedByteCache, allocateMemory } from '../src/access/ramdisk.js';
import { createAccess } from '../src/access/index.js';
import { createSharedBlock, readSharedBlock, sharedAvailable } from '../src/shared/shared.js';
import { bytesFrame, base64Frame, bytesOfFrame, bytesOf, base64Of, isFrame, createFrame } from '../src/shared/protocol.js';

test('the ramdisk is a backend of the access: the rules of the paths hold in it', async () => {
    const ramdisk = createRamdiskFileSystem();
    const access = createAccess({ root: process.cwd(), fs: ramdisk });

    await access.fs.writeText('notes/todo.md', '# todo');
    const read = await access.fs.readText('notes/todo.md');
    assert.equal(read.text, '# todo');
    assert.equal(read.path, 'notes/todo.md');

    // The tree of the memory is the tree of the disk.
    const listing = await access.fs.listFiles('.', { depth: 2 });
    assert.ok(listing.entries.some((entry) => entry.path === 'notes/todo.md'));

    // A path that leaves the root is refused, exactly as on the disk.
    await assert.rejects(() => access.fs.readText('../outside.txt'), /outside the working directory/);
    // A secret is never accessible.
    await assert.rejects(() => access.fs.readText('.env'), /not accessible/);
});

test('the ramdisk refuses a file over its cap', async () => {
    const ramdisk = createRamdiskFileSystem({ capacityBytes: 16 });
    await assert.rejects(
        () => ramdisk.writeFile('big.bin', new Uint8Array(32)),
        /too big for the ramdisk/,
    );
});

test('the cache of bytes is one memory: the parent writes, the worker reads', async () => {
    const cache = createSharedByteCache({ capacityBytes: 1024 });
    const picture = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

    const written = cache.write(picture);
    assert.equal(written, 8);
    assert.equal(cache.size(), 8);

    // The bytes are read without a copy: the view points into the same buffer.
    const view = cache.read();
    assert.equal(view.byteLength, 8);
    assert.deepEqual([...view], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(view.buffer, cache.buffer);

    // The other side of the same memory sees the same bytes.
    const other = createSharedByteCache({ shared: cache.buffer });
    assert.deepEqual([...other.read()], [1, 2, 3, 4, 5, 6, 7, 8]);

    // The block is emptied, and the other side sees that too.
    cache.release();
    assert.equal(other.size(), 0);
});

test('the cache refuses a picture that does not fit', () => {
    const cache = createSharedByteCache({ capacityBytes: 32 });
    // The block keeps a word for its own length: the bytes of the picture start after it.
    const room = cache.capacityBytes;
    assert.equal(cache.available(room), true);
    assert.equal(cache.available(room + 1), false);
    assert.throws(() => cache.write(new Uint8Array(room + 1)), /does not fit the shared cache/);
});

test('the shared block of the house is one memory in every package', () => {
    assert.equal(sharedAvailable(), true);
    const { buffer, regions } = createSharedBlock({
        instructions: 'The instructions of the role.',
        notes: 'The notes of the context.',
    });
    assert.deepEqual(regions, ['instructions', 'notes']);

    // The thread reads the very same bytes: the block is shared, not copied.
    const shared = readSharedBlock(buffer);
    assert.equal(shared.text('instructions'), 'The instructions of the role.');
    assert.equal(shared.text('notes'), 'The notes of the context.');

    // The flag of cancellation: the parent sets it, the thread sees it.
    assert.equal(shared.cancelled(), false);
    shared.cancel();
    assert.equal(readSharedBlock(buffer).cancelled(), true);
});

test('the bytes travel as a frame without a copy, and as base64 when the buffer cannot move', () => {
    const picture = Buffer.from([9, 8, 7, 6]);

    // The buffer that travels owns its own memory: a Buffer of the pool of Node.js may
    // not be transferred.
    const { frame, transfer } = bytesFrame(picture, { name: 'logo.png' });
    assert.equal(frame.type, 'bytes');
    assert.equal(frame.length, 4);
    assert.equal(transfer.length, 1);
    assert.deepEqual([...bytesOfFrame(frame)], [9, 8, 7, 6]);

    // The base64 frame carries the same bytes as text.
    const text = base64Frame(picture, { name: 'logo.png' });
    assert.equal(text.type, 'base64');
    assert.equal(text.length, 4);
    assert.deepEqual([...bytesOfFrame(text)], [9, 8, 7, 6]);
    assert.equal(text.data, Buffer.from([9, 8, 7, 6]).toString('base64'));

    // The bytes are read out of every shape.
    assert.deepEqual([...bytesOf(Buffer.from([1, 2]))], [1, 2]);
    assert.deepEqual([...bytesOf(new Uint8Array([3, 4]))], [3, 4]);
    assert.deepEqual([...bytesOf(new Uint8Array([5, 6]).buffer)], [5, 6]);
    assert.deepEqual([...bytesOf('AAEC')], [0, 1, 2]);
    assert.equal(base64Of(new Uint8Array([0, 1, 2])), 'AAEC');
});

test('the protocol refuses a frame of another version and an unknown kind', () => {
    assert.equal(isFrame(createFrame('status', { event: {} })), true);
    assert.equal(isFrame({ v: 99, type: 'status' }), false);
    assert.equal(isFrame({ v: 1, type: 'nonsense' }), false);
    assert.equal(isFrame(null), false);
    assert.throws(() => createFrame('nonsense'), /Unknown frame/);
});

test('the run may allocate a block of memory of 1, 2, 4 or 8 GB', () => {
    const GiB = 1024 * 1024 * 1024;
    for (const gigabytes of [1, 2, 4, 8]) {
        const block = allocateMemory({ bytes: gigabytes * GiB });
        assert.equal(block.capacityBytes, gigabytes * GiB);
        assert.equal(block.bytes.byteLength, gigabytes * GiB);
        // The block is one memory of the parent and the worker.
        assert.ok(block.buffer instanceof SharedArrayBuffer);
    }
    // The ceiling of the package is 8 GB.
    assert.throws(() => allocateMemory({ bytes: 9 * GiB }), /over the ceiling/);
    // The ceiling of the run may be lower.
    assert.throws(() => allocateMemory({ bytes: 4 * GiB, allocateBytes: 2 * GiB }), /over the ceiling/);
});
