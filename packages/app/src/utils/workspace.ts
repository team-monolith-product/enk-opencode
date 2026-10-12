/**
 * 튜토리얼 작업 폴더인지. 팀 pod 는 본행사(`project-directory`)와 튜토리얼(`tutorial-directory`) 두 폴더를 쓰고,
 * 이 이름 규약은 서버(ServeTargets)·rails mount_map·프론트가 함께 쓴다.
 */
export function isTutorialDirectory(directory: string) {
  return directory.split("/").includes("tutorial-directory")
}
