// Gregorian dates read in the French Republican calendar. The year begins on 22 September; twelve months
// of thirty days are followed by five complementary days, six in a sextile year.
//
// The Republic itself declared only years III, VII and XI sextile before the calendar was abolished. Later
// readings disagree about what follows. This one keeps the four-year rhythm those years set: III, VII, XI,
// XV and every fourth year after are sextile, with no century exceptions and no equinox observation, so
// every day maps to a date with plain arithmetic.
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(1792, 8, 22);
const GREGORIAN_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Years I to IV of each four-year cycle; the third is sextile. */
const CYCLE_YEAR_LENGTHS = [365, 365, 366, 365];
/**
 * The Republican date of a Gregorian calendar date written `YYYY-MM-DD`. The date is read as written,
 * whatever the process's time zone. Invalid dates and dates before 22 September 1792 raise a RangeError.
 */
export function republicanDate(localDate) {
    const parts = localDate.length === 10 ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate) : null;
    if (!parts)
        throw new RangeError(`expected a date written YYYY-MM-DD: ${localDate}`);
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthLength = month === 2 && leap ? 29 : GREGORIAN_MONTH_LENGTHS[month - 1];
    if (year < 1 || monthLength === undefined || day < 1 || day > monthLength)
        throw new RangeError(`not a Gregorian date: ${localDate}`);
    if (localDate < "1792-09-22")
        throw new RangeError(`the Republican calendar begins on 22 September 1792: ${localDate}`);
    const sinceEpoch = (Date.UTC(year, month - 1, day) - EPOCH_MS) / DAY_MS;
    let dayOfYear = sinceEpoch % 1461;
    let republicanYear = Math.floor(sinceEpoch / 1461) * 4 + 1;
    for (const length of CYCLE_YEAR_LENGTHS) {
        if (dayOfYear < length)
            break;
        dayOfYear -= length;
        republicanYear += 1;
    }
    if (dayOfYear < 360)
        return { year: republicanYear, month: Math.floor(dayOfYear / 30) + 1, day: dayOfYear % 30 + 1, complementary: false };
    return { year: republicanYear, month: null, day: dayOfYear - 359, complementary: true };
}
/** The calendar date `YYYY-MM-DD` in an IANA time zone at an instant. */
export function localDate(at, timeZone) {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
/** A year in Roman numerals, as the Republic numbered its years. */
export function roman(year) {
    let out = "";
    for (const [value, symbol] of ROMAN)
        while (year >= value) {
            out += symbol;
            year -= value;
        }
    return out;
}
