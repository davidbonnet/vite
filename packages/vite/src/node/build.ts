import fs from 'fs'
import path from 'path'
import chalk from 'chalk'
import { resolveConfig, InlineConfig, ResolvedConfig } from './config'
import Rollup, {
  Plugin,
  RollupBuild,
  RollupOptions,
  RollupWarning,
  WarningHandler,
  WarningHandlerWithDefault,
  OutputOptions,
  RollupOutput
} from 'rollup'
import { buildReporterPlugin } from './plugins/reporter'
import { buildDefinePlugin } from './plugins/define'
import { buildHtmlPlugin } from './plugins/html'
import { buildEsbuildPlugin } from './plugins/esbuild'
import { terserPlugin } from './plugins/terser'
import { Terser } from 'types/terser'
import { copyDir, emptyDir, lookupFile } from './utils'
import { manifestPlugin } from './plugins/manifest'
import commonjsPlugin from '@rollup/plugin-commonjs'
import dynamicImportVars from '@rollup/plugin-dynamic-import-vars'
import isBuiltin from 'isbuiltin'
import { Logger } from './logger'
import { TransformOptions } from 'esbuild'
import { CleanCSS } from 'types/clean-css'

export interface BuildOptions {
  /**
   * Base public path when served in production.
   * @default '/'
   */
  base?: string
  /**
   * Compatibility transform target. The transform is performed with esbuild
   * and the lowest supported target is es2015/es6. Note this only handles
   * syntax transformation and does not cover polyfills (except for dynamic
   * import)
   *
   * Default: 'modules' - Similar to `@babel/preset-env`'s targets.esmodules,
   * transpile targeting browsers that natively support es module imports. Also
   * injects a light-weight dynamic import polyfill.
   * https://caniuse.com/es6-module
   *
   * Another special value is 'esnext' - which only performs minimal trasnpiling
   * (for minification compat) and assumes native dynamic imports support.
   *
   * For custom targets, see https://esbuild.github.io/api/#target and
   * https://esbuild.github.io/content-types/#javascript for more details.
   */
  target?: 'modules' | TransformOptions['target'] | false
  /**
   * Whether to inject dynamic import polyfill. Defaults to `true`, unless
   * `target` is `'esnext'`.
   * Note: does not apply to library mode.
   */
  polyfillDynamicImport?: boolean
  /**
   * Directory relative from `root` where build output will be placed. If the
   * directory exists, it will be removed before the build.
   * @default 'dist'
   */
  outDir?: string
  /**
   * Directory relative from `outDir` where the built js/css/image assets will
   * be placed.
   * @default 'assets'
   */
  assetsDir?: string
  /**
   * Static asset files smaller than this number (in bytes) will be inlined as
   * base64 strings. Default limit is `4096` (4kb). Set to `0` to disable.
   * @default 4096
   */
  assetsInlineLimit?: number
  /**
   * Whether to code-split CSS. When enabled, CSS in async chunks will be
   * inlined as strings in the chunk and inserted via dynamically created
   * style tags when the chunk is loaded.
   * @default true
   */
  cssCodeSplit?: boolean
  /**
   * Whether to generate sourcemap
   * @default false
   */
  sourcemap?: boolean | 'inline'
  /**
   * Set to `false` to disable minification, or specify the minifier to use.
   * Available options are 'terser' or 'esbuild'.
   * @default 'terser'
   */
  minify?: boolean | 'terser' | 'esbuild'
  /**
   * Options for terser
   * https://terser.org/docs/api-reference#minify-options
   */
  terserOptions?: Terser.MinifyOptions
  /**
   * Options for clean-css
   * https://github.com/jakubpawlowicz/clean-css#constructor-options
   */
  cleanCssOptions?: CleanCSS.Options
  /**
   * Will be merged with internal rollup options.
   * https://rollupjs.org/guide/en/#big-list-of-options
   */
  rollupOptions?: RollupOptions
  /**
   * Whether to write bundle to disk
   * @default true
   */
  write?: boolean
  /**
   * Whether to emit a manifest.json under assets dir to map hash-less filenames
   * to their hashed versions. Useful when you want to generate your own HTML
   * instead of using the one generated by Vite.
   *
   * Example:
   *
   * ```json
   * {
   *   "main.js": { "file": "main.68fe3fad.js" },
   *   "style.css": { "file": "style.e6b63442.css" }
   * }
   * ```
   * @default false
   */
  manifest?: boolean
  /**
   * Build in library mode. The value should be the global name of the lib in
   * UMD mode. This will produce esm + cjs + umd bundle formats with default
   * configurations that are suitable for distributing libraries.
   */
  lib?: LibraryOptions | false
  /**
   * @internal for now
   */
  ssr?: boolean
}

export interface LibraryOptions {
  entry: string
  name?: string
  formats?: LibraryFormats[]
}

export type LibraryFormats = 'es' | 'cjs' | 'umd' | 'iife'

export function resolveBuildOptions(
  raw?: BuildOptions
): Required<BuildOptions> {
  const resolved: Required<BuildOptions> = {
    base: '/',
    target: 'modules',
    polyfillDynamicImport: raw?.target !== 'esnext' && !raw?.lib,
    outDir: 'dist',
    assetsDir: 'assets',
    assetsInlineLimit: 4096,
    cssCodeSplit: !raw?.lib,
    sourcemap: false,
    rollupOptions: {},
    minify: 'terser',
    terserOptions: {},
    cleanCssOptions: {},
    write: true,
    manifest: false,
    lib: false,
    ssr: false,
    ...raw
  }

  // handle special build targets
  if (resolved.target === 'modules') {
    // https://caniuse.com/es6-module
    resolved.target = ['es2019', 'edge16', 'firefox60', 'chrome61', 'safari11']
  } else if (resolved.target === 'esnext' && resolved.minify !== 'esbuild') {
    // esnext + terser: limit to es2019 so it can be minified by terser
    resolved.target = 'es2019'
  }

  // ensure base ending slash
  resolved.base = resolved.base.replace(/([^/])$/, '$1/')

  // normalize false string into actual false
  if ((resolved.minify as any) === 'false') {
    resolved.minify = false
  }

  return resolved
}

export function resolveBuildPlugins(
  config: ResolvedConfig
): { pre: Plugin[]; post: Plugin[] } {
  const options = config.build
  return {
    pre: [
      commonjsPlugin({
        include: [/node_modules/],
        extensions: ['.js', '.cjs']
      }),
      buildHtmlPlugin(config),
      buildDefinePlugin(config),
      dynamicImportVars({
        warnOnError: true,
        exclude: [/node_modules/]
      }),
      ...(options.rollupOptions.plugins || [])
    ],
    post: [
      buildEsbuildPlugin(config),
      ...(options.minify && options.minify !== 'esbuild'
        ? [terserPlugin(options.terserOptions)]
        : []),
      ...(options.manifest ? [manifestPlugin()] : []),
      ...(!config.logLevel || config.logLevel === 'info'
        ? [buildReporterPlugin(config)]
        : [])
    ]
  }
}

/**
 * Track parallel build calls and only stop the esbuild service when all
 * builds are done. (#1098)
 */
let parallelCallCounts = 0
// we use a separate counter to track since the call may error before the
// bundle is even pushed.
const paralellBuilds: RollupBuild[] = []

/**
 * Bundles the app for production.
 * Returns a Promise containing the build result.
 */
export async function build(
  inlineConfig: InlineConfig = {}
): Promise<RollupOutput | RollupOutput[]> {
  parallelCallCounts++
  try {
    return await doBuild(inlineConfig)
  } finally {
    parallelCallCounts--
    if (parallelCallCounts <= 0) {
      paralellBuilds.forEach((bundle) => bundle.close())
      paralellBuilds.length = 0
    }
  }
}

async function doBuild(
  inlineConfig: InlineConfig = {}
): Promise<RollupOutput | RollupOutput[]> {
  const config = await resolveConfig(
    {
      ...inlineConfig,
      mode: inlineConfig.mode || 'production'
    },
    'build'
  )

  config.logger.info(chalk.cyan(`building for production...`))

  const options = config.build
  const libOptions = options.lib
  const resolve = (p: string) => path.resolve(config.root, p)

  const input = libOptions
    ? libOptions.entry
    : options.rollupOptions?.input || resolve('index.html')
  const outDir = resolve(options.outDir)
  const publicDir = resolve('public')

  const rollup = require('rollup') as typeof Rollup

  try {
    const bundle = await rollup.rollup({
      input,
      preserveEntrySignatures: libOptions ? 'strict' : false,
      ...options.rollupOptions,
      plugins: config.plugins as Plugin[],
      onwarn(warning, warn) {
        onRollupWarning(
          warning,
          warn,
          config.optimizeDeps?.allowNodeBuiltins,
          options.rollupOptions?.onwarn
        )
      }
    })

    paralellBuilds.push(bundle)

    const pkgName =
      libOptions &&
      JSON.parse(lookupFile(config.root, ['package.json']) || `{}`).name

    const generate = (output: OutputOptions = {}) => {
      return bundle[options.write ? 'write' : 'generate']({
        dir: outDir,
        format: 'es',
        exports: 'auto',
        sourcemap: options.sourcemap,
        name: libOptions ? libOptions.name : undefined,
        entryFileNames: libOptions
          ? `${pkgName}.${output.format || `es`}.js`
          : path.posix.join(options.assetsDir, `[name].[hash].js`),
        chunkFileNames: libOptions
          ? `[name].js`
          : path.posix.join(options.assetsDir, `[name].[hash].js`),
        assetFileNames: libOptions
          ? `[name].[ext]`
          : path.posix.join(options.assetsDir, `[name].[hash].[ext]`),
        // #764 add `Symbol.toStringTag` when build es module into cjs chunk
        // #1048 add `Symbol.toStringTag` for module default export
        namespaceToStringTag: true,
        ...output
      })
    }

    if (options.write) {
      emptyDir(outDir)
      if (fs.existsSync(publicDir)) {
        copyDir(publicDir, outDir)
      }
    }

    // resolve lib mode outputs
    const outputs = resolveBuildOutputs(
      options.rollupOptions?.output,
      libOptions,
      config.logger
    )
    if (Array.isArray(outputs)) {
      const res = []
      for (const output of outputs) {
        res.push(await generate(output))
      }
      return res
    } else {
      return generate(outputs)
    }
  } catch (e) {
    config.logger.error(
      chalk.red(`${e.plugin ? `[${e.plugin}] ` : ``}${e.message}`)
    )
    if (e.id) {
      const loc = e.loc ? `:${e.loc.line}:${e.loc.column}` : ``
      config.logger.error(`file: ${chalk.cyan(`${e.id}${loc}`)}`)
    }
    if (e.frame) {
      config.logger.error(chalk.yellow(e.frame))
    }
    throw e
  }
}

function resolveBuildOutputs(
  outputs: OutputOptions | OutputOptions[] | undefined,
  libOptions: LibraryOptions | false,
  logger: Logger
): OutputOptions | OutputOptions[] | undefined {
  if (libOptions) {
    const formats = libOptions.formats || ['es', 'umd']
    if (
      (formats.includes('umd') || formats.includes('iife')) &&
      !libOptions.name
    ) {
      throw new Error(
        `Option "build.lib.name" is required when output formats ` +
          `include "umd" or "iife".`
      )
    }
    if (!outputs) {
      return formats.map((format) => ({ format }))
    } else if (!Array.isArray(outputs)) {
      return formats.map((format) => ({ ...outputs, format }))
    } else if (libOptions.formats) {
      // user explicitly specifying own output array
      logger.warn(
        chalk.yellow(
          `"build.lib.formats" will be ignored because ` +
            `"build.rollupOptions.output" is already an array format`
        )
      )
    }
  }
  return outputs
}

const warningIgnoreList = [`CIRCULAR_DEPENDENCY`, `THIS_IS_UNDEFINED`]
const dynamicImportWarningIgnoreList = [
  `Unsupported expression`,
  `statically analyzed`
]

export function onRollupWarning(
  warning: RollupWarning,
  warn: WarningHandler,
  allowNodeBuiltins: string[] = [],
  userOnWarn?: WarningHandlerWithDefault
) {
  function doWarn() {
    if (userOnWarn) {
      userOnWarn(warning, warn)
    } else {
      warn(warning)
    }
  }

  if (warning.code === 'UNRESOLVED_IMPORT') {
    let message: string
    const id = warning.source
    const importer = warning.importer

    if (importer && /\?commonjs-external$/.test(importer)) {
      // allow commonjs external...
      warning.message = chalk.yellow(warning.message)
      return doWarn()
    }

    if (id && isBuiltin(id)) {
      let importingDep: string | undefined
      if (importer) {
        const pkg = JSON.parse(lookupFile(importer, ['package.json']) || `{}`)
        if (pkg.name) {
          importingDep = pkg.name
        }
      }
      if (
        importingDep &&
        allowNodeBuiltins.some((allowed) => importingDep!.startsWith(allowed))
      ) {
        return
      }
      const dep = importingDep
        ? `Dependency ${chalk.yellow(importingDep)}`
        : `A dependency`
      message =
        `${dep} is attempting to import Node built-in module ${chalk.yellow(
          id
        )}.\n` +
        `This will not work in a browser environment.\n` +
        `Imported by: ${chalk.gray(importer)}`
    } else {
      message =
        `[vite]: Rollup failed to resolve import "${warning.source}" from "${warning.importer}".\n` +
        `This is most likely unintended because it can break your application at runtime.\n` +
        `If you do want to externalize this module explicitly add it to\n` +
        `\`build.rollupOptions.external\``
    }
    throw new Error(message)
  }

  if (
    warning.plugin === 'rollup-plugin-dynamic-import-variables' &&
    dynamicImportWarningIgnoreList.some((msg) => warning.message.includes(msg))
  ) {
    return
  }

  if (!warningIgnoreList.includes(warning.code!)) {
    doWarn()
  }
}
