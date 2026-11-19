import type { Profile } from '@hongyan/contracts';

export function hasStudentAccess(profile: Profile) {
  return (
    !!profile.student && profile.roles.some((role) => role === 'student' || role === 'organizer')
  );
}
