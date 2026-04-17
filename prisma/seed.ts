import { PrismaClient } from "@prisma/client";
import { dedupKey, normalizeEmail, normalizePhone } from "../src/lib/contact";

const prisma = new PrismaClient();

async function main() {
  const c = await prisma.campaign.create({
    data: {
      name: "National Day Reception 2026",
      description: "Annual diplomatic reception.",
      venue: "Diplomatic Quarter, Riyadh",
      locale: "ar",
      status: "draft",
      eventAt: new Date(Date.now() + 30 * 86400_000),
      rsvpDeadline: new Date(Date.now() + 20 * 86400_000),
    },
  });

  const people: Array<{
    fullName: string;
    title?: string;
    organization?: string;
    email?: string;
    phone?: string;
    locale?: "en" | "ar";
    guestsAllowed?: number;
  }> = [
    { fullName: "H.E. Dr. Saad Al-Faisal", title: "Minister", organization: "Ministry of Culture", email: "saad@example.gov.sa", phone: "+966501234567", locale: "ar", guestsAllowed: 2 },
    { fullName: "Jane Harrison", title: "Counsellor", organization: "British Embassy", email: "jane@ukmission.sa", phone: "+442071234567", locale: "en", guestsAllowed: 1 },
    { fullName: "محمد العتيبي", title: "وكيل", organization: "وزارة السياحة", phone: "+966551112223", locale: "ar" },
    { fullName: "Ahmed Al-Rashid", organization: "GCC Secretariat", email: "ahmed@gcc.example", phone: "+966559999888", locale: "en", guestsAllowed: 1 },
  ];

  for (const p of people) {
    const email = normalizeEmail(p.email);
    const phone = normalizePhone(p.phone ?? null, "SA");
    await prisma.invitee.create({
      data: {
        campaignId: c.id,
        fullName: p.fullName,
        title: p.title ?? null,
        organization: p.organization ?? null,
        email,
        phoneE164: phone,
        locale: p.locale ?? null,
        guestsAllowed: p.guestsAllowed ?? 0,
        dedupKey: dedupKey(email, phone),
      },
    });
  }

  console.log(`Seeded campaign ${c.id} with ${people.length} invitees.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
