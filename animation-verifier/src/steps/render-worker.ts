// Entry `worker_threads` untuk langkah 6 (design 5.9): memasang `runRenderJob` ke `parentPort`.
// Seluruh logika ada di `render-core.ts` supaya tes dapat memanggilnya tanpa spawn; berkas ini
// sengaja hanya perekat. Di thread utama (mis. diimpor oleh tes) berkas ini tidak berbuat apa pun.
// Satu Worker menjalankan satu pekerjaan: pesan `run` kedua diabaikan, dan Worker tidak menutup
// port sendiri, jadi induk menghentikannya dengan `terminate()` setelah menerima `result`
// (Worker dan konteks `vm` baru dibuat untuk invokasi berikutnya, Requirement 11.7).

import { isMainThread, parentPort } from "node:worker_threads";
import { isRunMessage, runRenderJob, type FromWorker } from "./render-core.js";

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  const post = (message: FromWorker): void => {
    try {
      port.postMessage(message);
    } catch {
      // Port sudah ditutup induk; tidak ada yang menunggu hasilnya.
    }
  };

  let started = false;
  port.on("message", (message: unknown) => {
    if (started || !isRunMessage(message)) return;
    started = true;
    void runRenderJob(message, post).then(post);
  });
}
