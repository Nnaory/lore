---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/lib/game/**", "frontend/src/lib/story/**", "frontend/src/lib/campaign/**", "frontend/src/components/story/**", "frontend/src/components/stage/**", "frontend/src/components/campaign/**", "frontend/src/components/play/**"]
---

# Game engine dan runtime story

## Game engine (`src/lib/game`, fungsi murni tanpa React)
- **`hp-manager.ts`**: `MAX_HP = 5`. Jawaban salah mengurangi 1. HP 0 berarti gagal.
- **`answer-validator.ts`**: `validateMultipleChoice` mengembalikan `correct | incorrect | empty | unknown_choice`. Ini satu-satunya penentu benar atau salah. AI tidak pernah memutuskan.
- **`knowledge-manager.ts`**: status `not_introduced < introduced < developing < demonstrated`, dan hanya bisa naik.
  - `demonstrated` hanya diberikan jika jawaban benar tanpa bukti puzzle sebelumnya di SEMUA run. Bukti disimpan di CampaignState, bukan counter per run.
  - Bukti dideduplikasi per `(reference_id, source)`.
  - Nilai source: `learning_scene`, `puzzle_correct_first_try`, `puzzle_correct_after_feedback`, `puzzle_incorrect`.
- **`campaign-manager.ts`**: story terbuka jika semua story sebelumnya selesai DAN semua `required_knowledge` sudah `demonstrated`. `completeStory` menerapkan delta world dan relationship dari ending, dan aman dipanggil dua kali.
- **`learning-summary.ts`**: evaluasi akhir dengan kategori mastered / developing / practice / unseen.

## Runtime story
- **`src/lib/story/story-player.ts`** (murni): status `reading | scene_end | puzzle | bad_branch | story_complete`. `returnToPuzzleSceneId` dibawa sepanjang bad branch.
- **`use-story-player.ts`**: state React plus HP. `retryStory` me-reset posisi dan HP; knowledge tetap.
- **`src/lib/campaign/use-campaign.ts`**: CampaignState, lobby, `onKnowledgeUpdate`.
- **`CampaignPlayer`** merender `CampaignSummary`, `CampaignLobby`, atau `StoryViewer`. `StoryViewer` di-key dengan `story_id` supaya remount tiap ganti story.
- **`StoryViewer`** adalah stage penuh layar (`lore-grid-bg` tanpa labu):
  - `StageHud` (bar penuh lebar layar, `bg-ink`);
  - `StageScene`: scene ASCII prosedural (`city_gate`) penuh layar di bawah HUD;
  - `StageSprite`: figur ASCII `renderCharacter` (desktop `z 20` di depan kotak dialog; phone `z 5` di belakang);
  - `StageCanvas`: Remotion Player 1280×720 @30fps dengan komposisi `ambient` (loop 300 frame), `lesson`, `visual`, `puzzle` (gambar rancangan AI + pertanyaan besar), dan `decision` (hanya pertanyaan, tanpa kotak jawaban). Mode `fast` langsung membuka frame terakhir. Player hanya di-mount di client;
  - Puzzle di Stage: `CanvasPane` menggambar `CanvasFrame` (`puzzle` bila `puzzle.visual` ada, atau `decision`), dan pada desktop meletakkan `PuzzleFeedback`, `ChoiceButton` (maksimal 4, tumbuh sampai 4 baris), dan `PuzzleActions` di bawah `CanvasFrame`. Di mobile, kotak dialog membesar dengan `PuzzleFeedback` tersemat di atas pilihan vertikal (`flex-col`). `StagePuzzle` (overlay lama) tidak dipakai UI;
  - `StageDialogue` / `DialogueBox`: efek typewriter, paginasi `3×68` desktop (`entryKey`), toggle `fast|animate`, tombol `log chat` yang membuka `ChatLog`.
- Ending "baik" adalah scene ending pertama di story. Ending bad branch ditaruh setelahnya.
- Fitur avatar pemain (kartu di home, `src/lib/avatar`, `src/lib/ascii`, figur di `AmbientScene`/`DecisionGraph`) dihapus 17 Nov 2026. Key `lore:avatar` yang mungkin tersisa di localStorage pengguna lama tidak dibaca lagi.

## Gotcha
- Dengan `cacheComponents`, halaman yang ditinggalkan tetap ter-mount secara tersembunyi (React `<Activity>`), lengkap dengan state-nya. `/create` punya effect khusus untuk me-reset form setelah story tersimpan. Hal yang sama berlaku untuk home: `HomeComposer` mengosongkan teks dan file saat kirim, supaya field bersih ketika pemain kembali.
- Remotion Player membaca jam saat render, jadi hanya di-mount setelah hydration (`useIsClient` di `StageCanvas`).
