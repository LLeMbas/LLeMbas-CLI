// Numbers as the person's locale writes them (harness display.md §6): the terminal's LC_ALL,
// LC_NUMERIC or LANG. With none of them, or the C locale, English grouping as before.
import { localeNumber, terminalLocale } from "../session/display.ts"

export const num = localeNumber(terminalLocale() ?? "en")
