type Units = {
	hour: (count: number) => string;
	minute: (count: number) => string;
	now: string;
	joined?: boolean;
};

function simple(one: string, many: string): (count: number) => string {
	return (count) => (count === 1 ? one : many);
}

function same(word: string): (count: number) => string {
	return () => word;
}

function slavic(one: string, few: string, many: string): (count: number) => string {
	return (count) => {
		const lastTwo = count % 100;
		const last = count % 10;
		if (last === 1 && lastTwo !== 11) {
			return one;
		}
		if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) {
			return few;
		}
		return many;
	};
}

function polish(one: string, few: string, many: string): (count: number) => string {
	const rule = slavic(one, few, many);
	return (count) => (count === 1 ? one : count % 10 === 1 ? many : rule(count));
}

const LANGUAGES: Record<string, Units> = {
	de: { hour: simple("STUNDE", "STUNDEN"), minute: simple("MINUTE", "MINUTEN"), now: "JETZT!" },
	es: { hour: simple("HORA", "HORAS"), minute: simple("MINUTO", "MINUTOS"), now: "¡YA!" },
	fr: { hour: simple("HEURE", "HEURES"), minute: simple("MINUTE", "MINUTES"), now: "MAINTENANT !" },
	pt: { hour: simple("HORA", "HORAS"), minute: simple("MINUTO", "MINUTOS"), now: "AGORA!" },
	it: { hour: simple("ORA", "ORE"), minute: simple("MINUTO", "MINUTI"), now: "ADESSO!" },
	pl: { hour: polish("GODZINA", "GODZINY", "GODZIN"), minute: polish("MINUTA", "MINUTY", "MINUT"), now: "TERAZ!" },
	ru: { hour: slavic("ЧАС", "ЧАСА", "ЧАСОВ"), minute: slavic("МИНУТА", "МИНУТЫ", "МИНУТ"), now: "СЕЙЧАС!" },
	tr: { hour: same("SAAT"), minute: same("DAKİKA"), now: "ŞİMDİ!" },
	id: { hour: same("JAM"), minute: same("MENIT"), now: "SEKARANG!" },
	vi: { hour: same("GIỜ"), minute: same("PHÚT"), now: "BẮT ĐẦU!" },
	th: { hour: same("ชั่วโมง"), minute: same("นาที"), now: "ตอนนี้!" },
	ja: { hour: same("時間"), minute: same("分"), now: "今すぐ！", joined: true },
	ko: { hour: same("시간"), minute: same("분"), now: "지금!", joined: true },
	"zh-hans": { hour: same("小时"), minute: same("分钟"), now: "现在！", joined: true },
	"zh-hant": { hour: same("小時"), minute: same("分鐘"), now: "現在！", joined: true },
};

function unitsFor(languageCode: string): Units | null {
	const code = languageCode.toLowerCase().replace("_", "-");
	return LANGUAGES[code] ?? LANGUAGES[code.split("-")[0]] ?? (code.startsWith("zh") ? LANGUAGES["zh-hans"] : null);
}

export function localizedLabel(mark: string, languageCode: string): string | null {
	const units = unitsFor(languageCode);
	if (!units) {
		return null;
	}
	if (mark === "now") {
		return units.now;
	}
	const match = /^(\d+)([mh])$/.exec(mark);
	if (!match) {
		return null;
	}
	const count = Number(match[1]);
	const word = match[2] === "h" ? units.hour(count) : units.minute(count);
	return units.joined ? `${count}${word}` : `${count} ${word}`;
}

export function hasTranslation(languageCode: string): boolean {
	return unitsFor(languageCode) !== null;
}

export const LABEL_LANGUAGES = Object.keys(LANGUAGES);
