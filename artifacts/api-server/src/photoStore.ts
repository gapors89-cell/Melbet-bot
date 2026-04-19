import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "..", "photos.json");

function load(): string[] {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as string[];
    }
  } catch {}
  return [];
}

function save(photos: string[]): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(photos, null, 2));
}

export function addPhoto(fileId: string): void {
  const photos = load();
  if (!photos.includes(fileId)) {
    photos.push(fileId);
    save(photos);
  }
}

export function getRandomPhoto(): string | null {
  const photos = load();
  if (photos.length === 0) return null;
  return photos[Math.floor(Math.random() * photos.length)]!;
}

export function countPhotos(): number {
  return load().length;
}
