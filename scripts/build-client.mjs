import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', here), 'utf8'));
const code = await build({
  absWorkingDir: fileURLToPath(here),
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  write: false,
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  external: manifest.dsh.client.external,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
if (code.outputFiles.length !== 1 || Object.values(code.metafile.outputs).some(output =>
  output.imports.some(item => !manifest.dsh.client.external.includes(item.path)))) {
  throw new Error('The DSH loader requires one factory with only declared client externals');
}
const factory = 'window.__ModuleLoader__.load({id:' + JSON.stringify(manifest.name)
  + ',factory:require=>{const module={exports:{}};const exports=module.exports;\n'
  + code.outputFiles[0].text + '\nreturn module.exports;}});\n';
await mkdir(new URL('lib/', here), { recursive: true });
await writeFile(new URL('lib/client.js', here), factory);
console.log('Built DSH client factory (' + Buffer.byteLength(factory) + ' bytes)');
