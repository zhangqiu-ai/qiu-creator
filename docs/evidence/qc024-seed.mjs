// Seed a throwaway CREATORHUB_HOME for QC-024: one work, no AI key yet.
// Usage: CREATORHUB_HOME=<temp home> node docs/evidence/qc024-seed.mjs
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.CREATORHUB_HOME;
if (!home || !home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');
const token = fs.readFileSync(path.join(home, 'data', 'api-token'), 'utf8').trim();
const res = await fetch('http://127.0.0.1:7420/api/v1/works', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    title: '我把書房改成剪輯室：半年後的取捨',
    source: 'mac-app',
    markdown:
      '# 我把書房改成剪輯室：半年後的取捨\n\n剛搬進來時，我以為書房只要一張大桌子就夠了。後來發現，真正耽誤剪輯的是線材、散熱和那台一直在響的風扇。所以這半年我陸續做了很多很多調整。\n\n## 一、桌子換成兩張\n\n原本的實木大桌很好看，但螢幕臂夾不住它的圓邊。我改成兩張 70 公分深的工作桌，一張放剪輯，一張只放紙筆。\n\n## 二、主機搬出房間\n\n風扇聲是最難忽略的噪音。主機移到隔壁衣櫃，用 5 公尺的線材連回桌面，房間安靜到可以直接錄旁白。\n',
  }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
console.log('work', (await res.json()).id);
