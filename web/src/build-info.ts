/** Build stamp shown in the footer, set at image build time (Dockerfile.web). */
export const BUILD_LABEL: string =
	import.meta.env?.VITE_BUILD_LABEL || 'Development build'

/** Where this version's source code is published. Set at build time. */
export const SOURCE_URL: string =
	import.meta.env?.VITE_SOURCE_URL || 'https://github.com/Daimon-Law/hiroh'

/** Licences of Hiroh and of the components it includes. */
export const LICENCES_URL = `${SOURCE_URL.replace(/\/$/, '')}/blob/main/NOTICE.md`
