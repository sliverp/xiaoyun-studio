"""Copy only already-public artwork, CC0 music and reviewed demo recordings."""
from pathlib import Path
import argparse,json,shutil
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',required=True,help='Local checkout of the public Xiaoyun Live repository')
source=Path(parser.parse_args().source).resolve()
for folder in ['public/builtin/avatar','public/builtin/bgm','public/demo']:(root/folder).mkdir(parents=True,exist_ok=True)
manifest=json.loads((source/'plugin/lib/avatar/manifest.json').read_text())
for name in manifest:shutil.copy2(source/'plugin/lib/avatar'/name,root/'public/builtin/avatar'/(name.split('.')[0]+'.png'))
for old,new in [('upbeat-loop.5990e9d7138f92ae.mp3','upbeat-loop.mp3'),('raspberry-jam.3ba57da085ef24b0.mp3','raspberry-jam.mp3'),('dance-field.fe6dd5f47f57bf17.mp3','dance-field.mp3'),('gymnopedie-no1.67cf2c79a9758331.mp3','gymnopedie-no1.mp3')]:shutil.copy2(source/'bgm'/old,root/'public/builtin/bgm'/new)
shutil.copy2(source/'bgm/LICENSE.txt',root/'public/builtin/bgm/LICENSE.txt')
client=(source/'plugin/lib/client.js').read_text();raw=client.split('const STAGE_CUES = ',1)[1];cues=json.JSONDecoder().raw_decode(raw)[0]
for cue in cues:
 old=cue['audioUrl'].split('asset=',1)[1];dest=cue['id']+'.mp3';shutil.copy2(source/'plugin/lib/stage-audio'/old,root/'public/demo'/dest);cue['audioUrl']='/assets/demo/'+dest
(root/'public/demo/cues.json').write_text(json.dumps(cues,ensure_ascii=False,indent=2)+'\n')
shutil.copy2(root/'public/demo/xiaoyun-greeting.mp3',root/'public/demo/greeting.mp3')
shutil.copy2(source/'LICENSE',root/'LICENSE')
(root/'THIRD-PARTY.md').write_text('''# Sources and licenses

Studio server, UI, compositor, state machine and direct API integration: Copyright (c) 2026 sliverp, MIT.

The project was extracted from the Xiaoyun Live work at https://github.com/sliverp/xiaoyun-live. Selected previous pure logic, public character art and reviewed demonstration recordings originate there. MIT copyright notices from biliye and sliverp are retained in LICENSE. The original speech plugin is https://github.com/biliye/dsh-voice-call (0.2.1, MIT). This application has no DSH or Cordis runtime dependency.

The bundled character is project demonstration artwork; product names and marks remain their owners’ property. Replace it for unrelated brand use. The green backdrop is removed at rendering time, and expressions switch directly rather than cross-fading.

Bundled background recordings are CC0. Composer, performer, original source and processing details are in public/builtin/bgm/LICENSE.txt. Provider SDK and Chromium/FFmpeg licenses are distributed by their respective packages and system distributions. FFmpeg codec licensing depends on the binary and use case; Docker uses Debian’s FFmpeg package.

Private stream keys, API credentials, browser sessions, audience identifiers, historical reports and the operator’s live presentation content are not included in this repository. The migration command copies presentation material to ignored local storage without changing the original installation.
''')
print('Copied 9 expressions, 4 CC0 BGM tracks and 6 reviewed demo cues; no credentials or browser profiles.')
