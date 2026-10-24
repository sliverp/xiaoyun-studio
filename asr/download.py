"""Initialize only this container's public SenseVoice model volume."""
from pathlib import Path
import urllib.request,tarfile,tempfile,shutil
root=Path('/models');root.mkdir(parents=True,exist_ok=True)
if not all((root/name).is_file() and (root/name).stat().st_size>0 for name in ['model.int8.onnx','tokens.txt']):
 url='https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'
 with tempfile.TemporaryDirectory() as temp:
  archive=Path(temp)/'model.tar.bz2';urllib.request.urlretrieve(url,archive)
  with tarfile.open(archive) as tar:
   for name in ['model.int8.onnx','tokens.txt']:
    files=[item for item in tar.getmembers() if Path(item.name).name==name and item.isfile()]
    if len(files)!=1:raise ValueError('Invalid model archive')
    with tar.extractfile(files[0]) as source,(root/(name+'.part')).open('wb') as output:shutil.copyfileobj(source,output)
    (root/(name+'.part')).replace(root/name)
