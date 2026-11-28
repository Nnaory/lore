// Tes snapshot kebijakan versi kontrak (design 4.5, Requirement 2.9): menyimpan pasangan
// `{contract_version, sha256}` dari JSON kanonik kontrak tanpa bidang `contract_version`
// (kunci terurut, tanpa spasi, UTF-8). Mengubah isi tanpa menaikkan versi menggagalkan tes,
// sehingga backend, verifier, dan runtime tidak pernah menjalankan aturan berbeda dengan nomor
// versi yang sama.
//
// Bila isi kontrak sengaja berubah: naikkan `contract_version` (dan `supported_runtime_contract_versions`
// bila runtime mendukungnya), jalankan sync kontrak, lalu perbarui SNAPSHOT di bawah ini.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ContractFingerprint {
  contract_version: number;
  sha256: string;
}

const SNAPSHOT: ContractFingerprint = {
  contract_version: 1,
  sha256: "bfff1068ca883355e1d097c188e4dea36320dedabeae4fe5522895e6f10c5bb0",
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Urutkan kunci object secara rekursif (urutan titik kode); larik mempertahankan urutan. */
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

/** JSON kanonik: kunci terurut, tanpa spasi. `JSON.stringify` selalu menghasilkan UTF-16 yang di-hash sebagai UTF-8. */
function canonicalJson(contract: { [key: string]: Json }): string {
  const rest = { ...contract };
  delete rest.contract_version;
  return JSON.stringify(sortKeys(rest));
}

function fingerprint(contract: { [key: string]: Json }): ContractFingerprint {
  return {
    contract_version: contract.contract_version as number,
    sha256: createHash("sha256").update(canonicalJson(contract), "utf8").digest("hex"),
  };
}

type PolicyResult = { ok: true } | { ok: false; reason: string };

/** Kebijakan: isi yang berubah wajib disertai versi baru, dan snapshot wajib mengikuti versi itu. */
function checkAgainstSnapshot(current: ContractFingerprint, snapshot: ContractFingerprint): PolicyResult {
  if (current.contract_version === snapshot.contract_version) {
    return current.sha256 === snapshot.sha256
      ? { ok: true }
      : {
          ok: false,
          reason: `contract content changed (sha256 ${current.sha256}) without bumping contract_version ${current.contract_version}`,
        };
  }
  return {
    ok: false,
    reason: `contract_version is ${current.contract_version} but the snapshot records ${snapshot.contract_version}; update SNAPSHOT to ${JSON.stringify(current)}`,
  };
}

function readContract(): { [key: string]: Json } {
  const url = new URL("../contract/animation-contract.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as { [key: string]: Json };
}

describe("canonicalJson", () => {
  it("mengurutkan kunci secara rekursif tanpa spasi", () => {
    const canonical = canonicalJson({ contract_version: 9, b: { z: 1, a: [2, { y: true, x: null }] }, a: "é" });
    expect(canonical).toBe('{"a":"é","b":{"a":[2,{"x":null,"y":true}],"z":1}}');
  });

  it("tidak memuat contract_version", () => {
    expect(canonicalJson({ contract_version: 1, a: 1 })).not.toContain("contract_version");
  });

  it("mempertahankan urutan elemen larik", () => {
    expect(canonicalJson({ contract_version: 1, list: ["b", "a"] })).toBe('{"list":["b","a"]}');
  });
});

describe("fingerprint kontrak", () => {
  it("tidak bergantung pada urutan kunci dan spasi di berkas, dan tidak pada contract_version", () => {
    const original = readContract();
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    const bumped = { ...original, contract_version: 99 };
    expect(fingerprint(reversed).sha256).toBe(fingerprint(original).sha256);
    expect(fingerprint(bumped).sha256).toBe(fingerprint(original).sha256);
    expect(fingerprint(bumped).contract_version).toBe(99);
  });

  it("berubah saat isi berubah (satu identifier terlarang tambahan)", () => {
    const original = readContract();
    const forbidden = original.forbidden as { identifier: string[] };
    const edited = structuredClone(original);
    (edited.forbidden as { identifier: string[] }).identifier = [...forbidden.identifier, "Reflect"];
    expect(fingerprint(edited).sha256).not.toBe(fingerprint(original).sha256);
  });

  it("berubah saat satu angka batas berubah", () => {
    const original = readContract();
    const edited = structuredClone(original);
    const limits = edited.limits as { source_max_bytes: number };
    limits.source_max_bytes += 1;
    expect(fingerprint(edited).sha256).not.toBe(fingerprint(original).sha256);
  });
});

describe("kebijakan versi", () => {
  it("lolos saat versi dan hash sama dengan snapshot", () => {
    expect(checkAgainstSnapshot(SNAPSHOT, SNAPSHOT)).toEqual({ ok: true });
  });

  it("gagal saat hash berubah sementara versi sama", () => {
    const result = checkAgainstSnapshot({ ...SNAPSHOT, sha256: "0".repeat(64) }, SNAPSHOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("without bumping contract_version");
  });

  it("mengubah isi kontrak tanpa menaikkan versi menggagalkan kebijakan", () => {
    const edited = structuredClone(readContract());
    (edited.forbidden as { member: string[] }).member.push("Math.floor");
    const result = checkAgainstSnapshot(fingerprint(edited), SNAPSHOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("without bumping contract_version");
  });

  it("menaikkan versi meminta snapshot diperbarui", () => {
    const edited = structuredClone(readContract());
    edited.contract_version = SNAPSHOT.contract_version + 1;
    (edited.forbidden as { member: string[] }).member.push("Math.floor");
    const result = checkAgainstSnapshot(fingerprint(edited), SNAPSHOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("update SNAPSHOT");
  });
});

describe("snapshot kontrak sumber", () => {
  it("contract_version dan sha256 sama dengan SNAPSHOT", () => {
    const current = fingerprint(readContract());
    const verdict = checkAgainstSnapshot(current, SNAPSHOT);
    expect(verdict, verdict.ok ? undefined : verdict.reason).toEqual({ ok: true });
    expect(current).toEqual(SNAPSHOT);
  });

  it("SNAPSHOT berbentuk versi bulat positif dan SHA-256 heksadesimal 64 karakter", () => {
    expect(Number.isInteger(SNAPSHOT.contract_version)).toBe(true);
    expect(SNAPSHOT.contract_version).toBeGreaterThanOrEqual(1);
    expect(SNAPSHOT.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
