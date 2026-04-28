const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

exports.default = async function afterPack(context) {
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName]
  const electronBinary = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}${ext}`
  )

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    resetAdHocDarwinSignature:
      context.electronPlatformName === 'darwin' && context.arch === 'arm64'
  })
}
