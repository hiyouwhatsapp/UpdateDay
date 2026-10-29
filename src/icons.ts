import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { localizedLabel } from "./labels.ts";

export const ICON_SIZE = 512;

const THUMBNAIL_URL = "https://thumbnails.roblox.com/v1/games/icons";
const BUNDLED_OVERLAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/hourglass");
export const STYLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/hourglass-styles");
export const HOURGLASS_STYLES = ["original", "classic", "pixel", "rounded", "glow", "blocky", "outline"];
const ORIGINAL_STYLE = "original";
const TEXT_WIDTH_LIMIT = 0.94;
const TEXT_BASELINE_SHIFT = 0.36;
const OVERLAY_EXTENSIONS = [".png", ".webp", ".svg"];
const LABEL_FONT = "Arial Black, Arial, Noto Sans, Noto Sans CJK SC, Microsoft YaHei, Malgun Gothic, Yu Gothic, Leelawadee UI, Noto Sans Thai, DejaVu Sans, sans-serif";
const WIDE_CHAR = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
const WIDE_CHAR_SCALE = 1.4;
const DEFAULT_OVERLAY = "default";
const LABEL_CHAR_WIDTH = 0.74;
const LABEL_MAX_FONT_RATIO = 0.2;
const LABEL_OUTLINE_RATIO = 0.22;
const DEFAULT_ART_HEIGHT_RATIO = 0.74;
const EDGE_MARGIN = 12;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export type OverlayAnchor = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center" | "full";

type Box = { x: number; y: number; size: number };

type Overlay = { path: string; hasText: boolean };

export type IconStyle = {
	overlayDir?: string;
	style?: string;
	hourglassSize?: number;
	hourglassY?: number;
	textSize?: number;
	textY?: number;
	labels?: Record<string, string>;
	anchor: OverlayAnchor;
	scale: number;
	dim: number;
	label: boolean;
	labelColor: string;
	labelOutline: string;
};

export async function fetchCurrentIcon(universeId: number): Promise<Buffer> {
	const query = `?universeIds=${universeId}&size=${ICON_SIZE}x${ICON_SIZE}&format=Png&isCircular=false&returnPolicy=PlaceHolder`;
	const response = await fetch(THUMBNAIL_URL + query);
	if (!response.ok) {
		throw new Error(`Could not look up the game icon (${response.status})`);
	}
	const entry = (await response.json()).data?.[0];
	if (!entry?.imageUrl || entry.state !== "Completed") {
		throw new Error(`Game icon isn't available yet (state: ${entry?.state ?? "missing"})`);
	}
	const image = await fetch(entry.imageUrl);
	if (!image.ok) {
		throw new Error(`Could not download the game icon (${image.status})`);
	}
	return Buffer.from(await image.arrayBuffer());
}

export async function snapshotIcon(universeId: number, path: string): Promise<Buffer> {
	const icon = await sharp(await fetchCurrentIcon(universeId)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
	writeFileSync(path, icon);
	return icon;
}

function findFile(dir: string, name: string): string | null {
	for (const extension of OVERLAY_EXTENSIONS) {
		const path = join(dir, name + extension);
		if (existsSync(path)) {
			return path;
		}
	}
	return null;
}

function findOverlay(dir: string, mark: string): Overlay | null {
	const exact = findFile(dir, mark);
	if (exact) {
		return { path: exact, hasText: true };
	}
	const fallback = findFile(dir, "default");
	return fallback ? { path: fallback, hasText: false } : null;
}

export function overlayFor(style: IconStyle, mark: string): Overlay {
	const userOverlay = style.overlayDir ? findOverlay(style.overlayDir, mark) : null;
	const overlay = userOverlay ?? findOverlay(BUNDLED_OVERLAY_DIR, mark);
	if (!overlay) {
		throw new Error(`No hourglass overlay found for "${mark}"`);
	}
	return overlay;
}

export function labelText(mark: string): string {
	if (mark === "now") {
		return "NOW!";
	}
	const match = /^(\d+)([smhd])$/.exec(mark);
	if (!match) {
		return mark.toUpperCase();
	}
	const count = Number(match[1]);
	const units: Record<string, string> = { s: "SEC", m: "MIN", h: "HOUR", d: "DAY" };
	return `${count} ${units[match[2]]}${count === 1 ? "" : "S"}`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function placement(style: IconStyle): Box {
	if (style.anchor === "full") {
		return { x: 0, y: 0, size: ICON_SIZE };
	}
	const size = Math.round(ICON_SIZE * style.scale);
	const far = ICON_SIZE - EDGE_MARGIN - size;
	const middle = Math.round((ICON_SIZE - size) / 2);
	if (style.anchor === "center") {
		return { x: middle, y: middle, size };
	}
	const x = style.anchor.endsWith("right") ? far : EDGE_MARGIN;
	const y = style.anchor.startsWith("top") ? EDGE_MARGIN : far;
	return { x, y, size };
}

function dimLayer(opacity: number): Buffer {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">
	<rect width="100%" height="100%" fill="#000000" fill-opacity="${opacity}"/>
</svg>`;
	return Buffer.from(svg);
}

function visualLength(text: string): number {
	let length = 0;
	for (const char of text) {
		length += WIDE_CHAR.test(char) ? WIDE_CHAR_SCALE : 1;
	}
	return length;
}

function labelSvg(text: string, box: Box, style: IconStyle): Buffer {
	const fontSize = Math.round(Math.min(box.size * LABEL_MAX_FONT_RATIO, box.size / (LABEL_CHAR_WIDTH * visualLength(text))));
	const outline = Math.round(fontSize * LABEL_OUTLINE_RATIO);
	const centerX = box.x + box.size / 2;
	const baseline = Math.round(box.y + box.size - outline / 2);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">
	<text x="${centerX}" y="${baseline}" text-anchor="middle" font-family="${LABEL_FONT}" font-weight="900"
		font-size="${fontSize}" fill="${style.labelColor}" stroke="${style.labelOutline}" stroke-width="${outline}"
		stroke-linejoin="round" paint-order="stroke">${escapeXml(text)}</text>
</svg>`;
	return Buffer.from(svg);
}

function customIcon(dir: string | undefined, mark: string): string | null {
	if (!dir) {
		return null;
	}
	const path = join(dir, `${mark}.png`);
	return existsSync(path) ? path : null;
}

export type RenderOptions = IconStyle & {
	customDir?: string;
	newIcon?: string;
	newIconAt: "now" | "end";
	localizeLabels?: boolean;
};

function plainIcon(source: Buffer | string): Promise<Buffer> {
	return sharp(source).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
}

function baseFor(original: Buffer, mark: string, options: RenderOptions): Buffer | string {
	if (mark === "now" && options.newIcon && options.newIconAt === "now") {
		return options.newIcon;
	}
	return original;
}

export async function renderIcon(original: Buffer, mark: string, options: RenderOptions, languageCode?: string): Promise<Buffer> {
	if (mark === "final") {
		return plainIcon(options.newIcon ?? original);
	}
	const custom = customIcon(options.customDir, mark);
	if (custom) {
		return plainIcon(custom);
	}
	const base = await plainIcon(baseFor(original, mark, options));
	const translated = languageCode && options.localizeLabels !== false ? localizedLabel(mark, languageCode) : null;
	const ownText = options.labels?.[mark]?.trim() || null;
	return composeIcon(base, mark, options, translated ?? ownText);
}

function usesStyle(style: IconStyle): boolean {
	return Boolean(style.style) && style.style !== ORIGINAL_STYLE && !style.overlayDir;
}

export function stylePath(name: string): string {
	return join(STYLE_DIR, `${name}.png`);
}

function textSvg(text: string, centerY: number, sizeRatio: number, style: IconStyle): Buffer {
	const widest = (ICON_SIZE * TEXT_WIDTH_LIMIT) / (LABEL_CHAR_WIDTH * visualLength(text));
	const fontSize = Math.round(Math.min(ICON_SIZE * sizeRatio, widest));
	const outline = Math.round(fontSize * LABEL_OUTLINE_RATIO);
	const baseline = Math.round(centerY + fontSize * TEXT_BASELINE_SHIFT);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">
	<text x="${ICON_SIZE / 2}" y="${baseline}" text-anchor="middle" font-family="${LABEL_FONT}" font-weight="900"
		font-size="${fontSize}" fill="${style.labelColor}" stroke="${style.labelOutline}" stroke-width="${outline}"
		stroke-linejoin="round" paint-order="stroke">${escapeXml(text)}</text>
</svg>`;
	return Buffer.from(svg);
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

async function composeStyled(base: Buffer, mark: string, style: IconStyle, labelOverride?: string | null): Promise<Buffer> {
	const size = Math.round(ICON_SIZE * clamp(style.hourglassSize ?? 0.66, 0.1, 1));
	const centerY = ICON_SIZE * clamp(style.hourglassY ?? 0.4, 0, 1);
	const top = Math.round(clamp(centerY - size / 2, 0, ICON_SIZE - size));
	const left = Math.round((ICON_SIZE - size) / 2);
	const art = await sharp(stylePath(style.style!)).resize(size, size, { fit: "contain", background: TRANSPARENT }).png().toBuffer();
	const layers: sharp.OverlayOptions[] = [];
	if (style.dim > 0) {
		layers.push({ input: dimLayer(Math.min(style.dim, 1)) });
	}
	layers.push({ input: art, left, top });
	if (style.label) {
		layers.push({ input: textSvg(labelOverride || labelText(mark), ICON_SIZE * clamp(style.textY ?? 0.85, 0, 1), clamp(style.textSize ?? 0.15, 0.04, 0.4), style) });
	}
	return sharp(base).resize(ICON_SIZE, ICON_SIZE).composite(layers).png().toBuffer();
}

export async function composeIcon(base: Buffer, mark: string, style: IconStyle, labelOverride?: string | null): Promise<Buffer> {
	if (usesStyle(style)) {
		return composeStyled(base, mark, style, labelOverride);
	}
	const overlay = overlayFor(style, labelOverride ? DEFAULT_OVERLAY : mark);
	const box = placement(style);
	const drawLabel = Boolean(labelOverride) || (style.label && !overlay.hasText);
	const artHeight = drawLabel ? Math.round(box.size * DEFAULT_ART_HEIGHT_RATIO) : box.size;
	const art = await sharp(overlay.path, { density: 300 })
		.resize(box.size, artHeight, { fit: "contain", background: TRANSPARENT })
		.png()
		.toBuffer();
	const layers: sharp.OverlayOptions[] = [];
	if (style.dim > 0) {
		layers.push({ input: dimLayer(Math.min(style.dim, 1)) });
	}
	layers.push({ input: art, left: box.x, top: box.y });
	if (drawLabel) {
		layers.push({ input: labelSvg(labelOverride || labelText(mark), box, style) });
	}
	return sharp(base)
		.resize(ICON_SIZE, ICON_SIZE)
		.composite(layers)
		.png()
		.toBuffer();
}
