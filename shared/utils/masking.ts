export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function buildPhoneFull(part1: string, part2: string, part3: string): string {
  return `${part1}-${part2}-${part3}`;
}

export function maskPhone(phoneFull: string): string {
  const [p1, , p3] = phoneFull.split("-");
  return `${p1 || ""}-****-${p3 || ""}`;
}

export function maskBirthdate(birthdate: string): string {
  const [year] = birthdate.split("-");
  return `${year || ""}-**-**`;
}

export function validatePhoneParts(part1: string, part2: string, part3: string): string | null {
  if (part1 !== "010" || !/^\d{4}$/.test(part2) || !/^\d{4}$/.test(part3)) {
    return "휴대폰번호는 010-0000-0000 형식으로 입력해 주세요.";
  }
  return null;
}
