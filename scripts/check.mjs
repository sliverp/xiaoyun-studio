/** Check repository-owned JavaScript and reject publishable credentials or private machine paths. */
import {readdirSync,readFileSync} from 'node:fs'
import {relative,join,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const root=fileURLToPath(new URL('../',import.meta.url))
const omitted=new Set(['.git','.data','node_modules','artifacts','backups','coverage','__pycache__'])
const textExtensions=new Set(['.mjs','.js','.json','.md','.txt','.html','.css','.svg','.yaml','.yml','.toml','.py','.sh','.example'])
const failures=[],sources=[],texts=[]
function walk(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(omitted.has(entry.name)||entry.name==='.DS_Store'||entry.name.endsWith('.log'))continue
    const path=join(directory,entry.name),name=relative(root,path)
    if(entry.isDirectory())walk(path)
    else if(entry.isSymbolicLink())failures.push(`${name}: symbolic links must be reviewed before publication`)
    else if(entry.isFile()){
      if(entry.name==='.env'||/^\.env\.(?!example$|sample$)/.test(entry.name))failures.push(`${name}: private environment file is present`)
      if(['.mjs','.js'].includes(extname(path)))sources.push(path)
      if(textExtensions.has(extname(path))||['Dockerfile','LICENSE','.gitignore','.dockerignore','.env.example'].includes(entry.name))texts.push(path)
    }
  }
}
walk(root)
for(const path of sources){
  const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'})
  if(result.status!==0)failures.push(`${relative(root,path)}: JavaScript syntax check failed`)
}
// Match complete token formats, never print a matched value in a diagnostic.
const forbidden=[
  ['API credential',/\bsk-(?:tp-)?[A-Za-z0-9_-]{24,}\b/g],
  ['Tencent credential',/\bAKID[A-Za-z0-9]{24,}\b/g],
  ['GitHub credential',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['private machine path',/(?:\/Users\/[A-Za-z0-9_.-]+\/|[A-Z]:\\Users\\[A-Za-z0-9_.-]+\\)/g],
  ['private deployment URL',/\b[a-z0-9.-]+\.devcloud\.woa\.com\b/gi],
]
for(const path of texts){
  const contents=readFileSync(path,'utf8')
  for(const [label,pattern] of forbidden){
    pattern.lastIndex=0
    for(const match of contents.matchAll(pattern)){
      const line=contents.slice(0,match.index).split('\n').length
      failures.push(`${relative(root,path)}:${line}: ${label} must not be published`)
    }
  }
}
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'))
const dependencyNames=new Set([
  ...Object.keys(manifest.dependencies||{}),...Object.keys(manifest.devDependencies||{}),...Object.keys(manifest.optionalDependencies||{}),
  ...Object.keys(lock.packages||{}).filter(Boolean).map(path=>path.split('node_modules/').at(-1)),
])
for(const name of dependencyNames){
  if(/(?:^|\/)dsh(?:-|$)|(?:^|\/)cordis(?:$|-|\/)|^@(?:deepseek-ai|cordisjs|cordis)\//i.test(name))failures.push(`package.json/package-lock.json: unsupported harness runtime dependency ${name}`)
}
if(failures.length){
  console.error('Repository checks failed:\n'+[...new Set(failures)].map(value=>'  '+value).join('\n'))
  process.exitCode=1
}else console.log(`Repository checks passed: ${sources.length} JavaScript files, ${texts.length} text files; no harness dependencies or recognized credential/private-path patterns. Run npm test separately.`)
