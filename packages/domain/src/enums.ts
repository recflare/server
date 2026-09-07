/**
 * Domain enums — the numeric codes the Rec Room client encodes into the room /
 * room-instance JSON we store in D1. Single source of truth so workers reference
 * a name instead of re-hardcoding the integer. Regular (not `const`) enums, since
 * the tsconfig sets `isolatedModules` (which disallows `const enum` across files).
 */

/**
 * PlatformType, the client's platform enum. Declaration order is wire order. The
 * `platform` form field is posted as the integer; a token's `platform` claim carries it
 * too. `auth` re-exports this as the source for its OpenAPI schema and description.
 *
 * A plain `as const` object rather than an `enum` like its neighbours, and deliberately
 * so: `auth` builds `PlatformTypeSchema`'s description by walking `Object.entries`, and a
 * numeric TS enum also emits a REVERSE mapping (`{ '0': 'Steam', Steam: 0, … }`), which
 * would double every member in the generated spec.
 *
 * Everything from `Steam` to `Pico` is a real Rec Room client platform, numbered by the
 * client. `Discord` is OURS — it is not a platform anyone signs in from, and the client
 * never sends it. It exists so a verified Discord identity can be stored as an account
 * link like any other external identity (see `auth`'s platform-db and the website's
 * benefits claim); it sits at 101, well clear of the client's range, so a future client
 * platform can be added without colliding with it.
 */
export const PlatformType = {
	All: -1,
	Steam: 0,
	Oculus: 1,
	PlayStation: 2,
	Xbox: 3,
	RecNet: 4,
	IOS: 5,
	GooglePlay: 6,
	Standalone: 7,
	Pico: 8,
	Discord: 101,
} as const

export type PlatformType = (typeof PlatformType)[keyof typeof PlatformType]

/** The kind of a room instance (live session), matching the client's `RoomInstanceType`. */
export enum RoomInstanceType {
	Public = 0,
	Private = 1,
	Dormroom = 2,
	Event = 3,
	Meetup = 4,
	Clubhouse = 5,
}

/**
 * The `Type` byte on a messaging `Message` — how the client dispatches a message it
 * receives (a game invite renders the join prompt, a text message the chat bubble, …).
 * Distinct from the notify hub's {@link NotificationType}: a message is delivered *as*
 * a `MessageReceived` (NotificationType 2) notification whose payload is a `Message`,
 * and this enum is that inner `Message.Type`. Mirrors the reference's `MessageType`.
 */
export enum MessageType {
	GameInvite = 0,
	GameInviteDeclined = 1,
	GameJoinFailed = 2,
	PartyActivitySwitch = 3,
	FriendInvite = 4,
	VoteToKick = 5,
	GameInviteV2 = 6,
	PartyActivitySwitchV2 = 7,
	RequestGameInvite = 10,
	RequestGameInviteDeclined = 11,
	FriendStatusOnline = 20,
	TextMessage = 30,
	FriendRequestAccepted = 40,
	PlayerCheer = 50,
	PlayerCheerAnonymous = 51,
	RoomCoOwnerAdded = 60,
	RoomCoOwnerRemoved = 61,
	RoomCoOwnerInvited = 62,
	CreatorPublishedNewRoom = 70,
	PlayerAttendingEvent = 80,
	PlayerEventInvitation = 81,
	DeprecatedGroupInvitation = 90,
	DeprecatedPlayerJoinedGroup = 91,
	CoachMessage = 100,
	NewRoomComments = 110,
	PartyUpRequest = 120,
	FriendIntroduction = 130,
	ClubMemberInvited = 200,
	ClubModeratorInvited = 201,
	ClubCoownerInvited = 202,
	VirtualClubAnnouncementRoomPublished = 100000,
	VirtualClubAnnouncementInventionPublished = 100001,
	VirtualClubAnnouncementGeneric = 100002,
	VirtualClubAnnouncementPlayerEventPublished = 100003,
	VirtualClubAnnouncementClub = 100004,
	VirtualClubAnnouncementPlayer = 100005,
	VirtualClubAnnouncementCode = 100006,
	VirtualClubAnnouncementPhoto = 100007,
	VirtualRoomNotification = 100008,
}

/**
 * What a v2 game invite (`MessageType.GameInviteV2`) is ASKING FOR — the `InviteMode` in
 * its `Data` envelope. It's the intent behind the invite, not the room being invited into:
 * the same instance is named whether you're pulling a party along or asking one player to
 * come play.
 *
 * The values are sparse and grouped: 0–4 are the party-management modes, 20+ the invite
 * ones. A plain "join me" is {@link PlayTogether}; {@link InviteParty} is the other
 * reading of it, and the two have not been told apart on the wire yet.
 */
export enum InviteMode {
	None = 0,
	LeaveParty = 1,
	InviteParty = 2,
	PartyAutoFollow = 3,
	EveryoneAutoFollow = 4,
	InviteOnlineFriends = 20,
	FullInstanceReinvite = 21,
	PlayTogether = 22,
}

/**
 * A room's (or image's) visibility, matching the client's `RoomAccessibility`. The
 * client declares the enum without explicit values, so these are its ordinals — and
 * it sends the NAME, not the number, on the subroom accessibility route.
 *
 * `Unlisted` is NOT a lesser `Public`: an unlisted room is open to anyone who has a
 * link or an invite, it just doesn't surface in the catalogs (hot/search/
 * recommendations/featured/similar, which all key on `Public`). `Private` is the
 * unpublished state — a room its owner hasn't opened up at all, which is where a
 * freshly cloned room starts.
 */
export enum Accessibility {
	Private = 0,
	Public = 1,
	Unlisted = 2,
	Dev_only = 3,
	Dev_Unlisted = 4,
}

/**
 * The `errorCode` a matchmaking response carries, matching the client's
 * `MatchmakingErrorCode`. `Success` (0) comes with an instance; every other code comes
 * with a null one. The numbering is sparse — these are the client's declared values,
 * gaps included, so don't renumber or fill them in.
 *
 * We only ever answer a few of these. Most refusals are deliberately opaque
 * ({@link MatchmakingErrorCode.NoSuchRoom}), since telling someone a room exists but is
 * closed to them leaks more than it helps; {@link MatchmakingErrorCode.BannedFromRoom}
 * is the exception, because a banned player already knows the room is there. The rest
 * are here so a code seen in a client log has a name.
 */
export enum MatchmakingErrorCode {
	UnknownError = -1,
	Success = 0,
	NoSuchGame = 1,
	PlayerNotOnline = 2,
	InsufficientSpace = 3,
	EventNotStarted = 4,
	EventAlreadyFinished = 5,
	BlockedFromRoom = 7,
	JuniorNotAllowed = 11,
	Banned = 12,
	AlreadyInBestInstance = 13,
	InsufficientRelationship = 14,
	UpdateRequired = 16,
	AlreadyInTargetInstance = 17,
	UGCNotAllowed = 19,
	NoSuchRoom = 20,
	RoomIsNotActive = 22,
	RoomBlockedByCreator = 23,
	RoomIsPrivate = 25,
	RoomInstanceIsPrivate = 26,
	DeviceClassNotSupported = 30,
	DeviceClassNotSupportedByRoomOwner = 31,
	MovementModeNotSupportedByRoomOwner = 32,
	EventIsPrivate = 35,
	EventIsFull = 36,
	RoomInviteExpired = 40,
	NoAvailableRegion = 45,
	NotorietyTooPoor = 50,
	BannedFromRoom = 55,
	NoSuchClub = 70,
	ClubHasNoClubhouse = 71,
	ClubIsNotActive = 73,
	NotAMemberOfClub = 74,
	BannedFromClub = 75,
	InstanceJoinNotPermitted = 76,
	LevelTooLow = 77,
	ChatPartyInviteNotFound = 78,
	ChatPartyInviteModerated = 79,
	ChatMessageNotAnInvite = 80,
	DeveloperOnly = 81,
	RRPlusRequired = 82,
	MetaJuniorAccountRestriction = 83,
	NotExclusivelyLoggedIn = 84,
	AccountDoesNotExist = 85,
	RoomInstanceBlockedByMatchmakingPolicy = 86,
}

/**
 * A room-role tier (the `Role` byte on a room's `Roles` entries), matching the
 * client's values. Host and Moderator are limited-permission helper tiers; CoOwner
 * and Creator are the owner-level tiers that may manage the room (see
 * {@link canManageRoom}). Creator is the room's owner (its `CreatorAccountId`) —
 * the max byte.
 */
export enum Role {
	Host = 10,
	Moderator = 20,
	CoOwner = 30,
	Creator = 255,
}
