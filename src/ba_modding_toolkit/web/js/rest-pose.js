// The animation a memorial lobby skeleton rests in once its intro is over, shared by the lobby player (lobby.js) and
// the thumbnails (thumbs.js), so a still of a lobby shows the pose the lobby settles into, never its first frame.
//
// The looping idle: the SpineCharacter's idle clip, else Idle_01, else the prefab's start animation, else the first
// other animation (Dummy last); never an intro (Hasumi_home's prefab starts "Start_Idle", which must not loop). A
// skeleton with intros only gets none: Shigure's Shigure_00 and Shigure_01, the scenes of her lobby's intro timeline,
// parked beside the scene, rest in their setup pose as spine-unity leaves them when the timeline's clip ends (looped,
// Shigure_00's train crossed the bottom of the view in front of her).
// idle: the prefab's idle clip for the skeleton (lobby.json idle) and animation: its start animation, where known; a
// thumbnail has only the skeleton, which is Idle_01 on every lobby of the game.
export function lobbyIdles(data, { idle = null, animation = null } = {}) {
  const ok = (n) => n && !/^start_/i.test(n) && data.findAnimation(n);
  const names = [idle, "Idle_01", animation,
    ...data.animations.filter((a) => /idle|loop|rest/i.test(a.name)).map((a) => a.name),
    ...data.animations.filter((a) => a.name !== "Dummy").map((a) => a.name), "Dummy"];
  const candidates = [...new Set(names.filter(ok))];
  // Repackers sometimes keep an empty placeholder under the original idle's name.
  return candidates.filter((n) => data.findAnimation(n).timelines?.length !== 0)
    .concat(candidates.filter((n) => data.findAnimation(n).timelines?.length === 0));
}
export const lobbyIdle = (data, options) => lobbyIdles(data, options)[0] || null;
