export {
	validateAndGetAccountId,
	validateAndGetBuild,
	validateAndGetPlus,
	validateAndGetRoles,
	validateAndGetVersion,
	generateToken,
	generateStudioBuildValidationToken,
	validateStudioBuildValidationToken,
	generatePhotonAuthToken,
	TOKEN_TTL_SECONDS,
} from './jwt'
export type { PhotonAuthClaims } from './jwt'
