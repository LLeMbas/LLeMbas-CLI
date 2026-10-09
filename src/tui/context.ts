import type { SyntaxStyle } from "@opentui/core"
import { createContext, useContext } from "solid-js"
import type { App } from "../app.ts"
import type { View } from "./state.ts"
import type { Theme } from "./theme.ts"

export interface Ctx {
  app: App
  view: View
  theme: () => Theme
  md: () => SyntaxStyle
  thought: () => SyntaxStyle
  /** Terminal size, from ONE resize subscription in Root: per-item subscriptions leaked listeners
   *  (and Node's warning about them printed over the screen). */
  dims: () => { width: number; height: number }
}

export const TuiContext = createContext<Ctx>()

export function useTui(): Ctx {
  const c = useContext(TuiContext)
  if (!c) throw new Error("TuiContext missing")
  return c
}
