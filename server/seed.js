import db, { computeScore } from "./db.js";

// Optional demo data so the app is not empty on first run. Every business
// below is invented. Run `npm run seed` once, look around, then select all on
// the Leads page and delete them before you load real prospects.
//
// The email templates are the part worth keeping. Edit them to sound like you.

const leadCount = db.prepare("SELECT COUNT(*) AS n FROM leads").get().n;
if (leadCount > 0) {
  console.log(`Database already has ${leadCount} leads - skipping seed.`);
  process.exit(0);
}

const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const leads = [
  { business_name: "Riverside Plumbing Co", owner_name: "Mike Torres", phone: "(305) 555-0142", email: "owner@example.com", location: "1240 Biscayne Blvd, Miami, FL 33132, USA", industry: "Plumbing", website_status: "No Website", outreach_status: "Interested", outreach_channel: "Email", last_contact_date: daysFromNow(-2), next_followup_date: daysFromNow(1), star_rating: 4.8, review_count: 127, notes: "Wants to see examples of other plumber sites." },
  { business_name: "Green Acre Lawn Care", owner_name: "Dana Whitfield", phone: "(305) 555-0177", email: "hello@example.com", location: "88 W 49th St, Hialeah, FL 33012, USA", industry: "Landscaping", website_status: "No Website", outreach_status: "Contacted", outreach_channel: "Email", last_contact_date: daysFromNow(-4), next_followup_date: daysFromNow(-1), star_rating: 4.5, review_count: 63 },
  { business_name: "Midtown Auto Detail", owner_name: "Ray Simmons", phone: "(305) 555-0163", email: "", location: "451 NW 27th Ave, Miami, FL 33125, USA", industry: "Auto Detailing", website_status: "Outdated", website_url: "http://example.com", outreach_status: "Not Contacted", star_rating: 4.9, review_count: 88 },
  { business_name: "Bella's Hair Studio", owner_name: "Bella Ruiz", phone: "(305) 555-0119", email: "salon@example.com", location: "12 Miracle Mile, Coral Gables, FL 33134, USA", industry: "Salon", website_status: "No Website", outreach_status: "Booked", outreach_channel: "Phone", last_contact_date: daysFromNow(-1), star_rating: 4.7, review_count: 214, notes: "Demo booked for next Tuesday 2pm." },
  { business_name: "Blue Dome Diner", owner_name: "Tom Nguyen", phone: "(305) 555-0188", email: "eat@example.com", location: "300 SW 8th St, Miami, FL 33130, USA", industry: "Restaurant", website_status: "Outdated", website_url: "http://example.com", outreach_status: "Follow-Up 1", outreach_channel: "Email", last_contact_date: daysFromNow(-5), next_followup_date: daysFromNow(2), star_rating: 4.3, review_count: 342 },
  { business_name: "Clearwater Pool Service", owner_name: "Carl Jenkins", phone: "(305) 555-0151", email: "pools@example.com", location: "77 SW 88th St, Kendall, FL 33176, USA", industry: "Pool Service", website_status: "No Website", outreach_status: "Replied", outreach_channel: "Email", last_contact_date: daysFromNow(-3), next_followup_date: daysFromNow(0), star_rating: 4.6, review_count: 51, notes: "Asked about pricing, send the audit." },
  { business_name: "Happy Paws Grooming", owner_name: "Lisa Chen", phone: "(305) 555-0134", email: "woof@example.com", location: "915 NW 87th Ave, Doral, FL 33172, USA", industry: "Pet Grooming", website_status: "No Website", outreach_status: "Not Contacted", star_rating: 5.0, review_count: 96 },
  { business_name: "Summit Roofing & Repair", owner_name: "Frank Delgado", phone: "(305) 555-0109", email: "", location: "204 N Krome Ave, Homestead, FL 33030, USA", industry: "Roofing", website_status: "No Website", outreach_status: "Not Interested", outreach_channel: "Phone", last_contact_date: daysFromNow(-10), star_rating: 4.1, review_count: 33, notes: "Nephew handles the internet stuff." },
];

for (const lead of leads) {
  lead.lead_score = computeScore(lead);
  const cols = Object.keys(lead);
  db.prepare(`INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...Object.values(lead));
}

// Two first-touch tracks: one for businesses with no website at all, one for
// businesses whose site has problems. The composer picks the right one per
// lead. {site_issue} is filled from that lead's own website scan.
const templates = [
  {
    name: "Initial - No Website",
    kind: "initial",
    subject: "{business_name}: your {rating} stars are invisible on Google",
    body: `{greeting}

I was looking up {industry} in {city} and noticed something odd: {business_name} has {reviews} reviews averaging {rating} stars, but no website. So when someone hears your name and goes looking, there's nothing to find.

That gap is where jobs quietly go to whoever shows up instead.

I build clean, mobile-friendly websites for local businesses. Before you decide anything, I'd like to build you a free homepage mockup of what {business_name} could look like online. No charge, no strings. If you like it, we talk. If not, it's yours to keep.

Reply "show me" and I'll have it to you within a few days.

Erik

P.S. If a website just isn't on your radar right now, reply "no thanks" and that's the last you'll hear from me. Your {rating} stars deserve to be seen either way.`,
  },
  {
    name: "Initial - Site Fix-Up",
    kind: "initial",
    subject: "found a few things on the {business_name} website",
    body: `{greeting}

I was on the {business_name} website today. You clearly don't need convincing to be online, you're already there. So I'll be specific about why I'm writing: {site_issue}.

Small things like that quietly cost you calls, and they're usually nobody's job to catch.

I run these checkups and fix these exact problems for local businesses. If you want, I'll send you the full report I ran on your site. Free, no strings, yours to keep or hand to whoever manages the site now.

Reply "send it" and it's in your inbox the same day.

Erik

P.S. Not interested? Reply "no thanks" and I won't email again.`,
  },
  {
    name: "Follow-Up 1",
    kind: "followup1",
    subject: "re: {business_name}",
    body: `{greeting}

Floating this back to the top of your inbox. Buried usually isn't a no, so I figured {business_name} deserved one more shot at it.

The offer stands: free work up front, so you can judge me on the result instead of the promise.

Reply "show me" and I'll get it over to you this week.

Erik

P.S. One reply either way and I'll stop nudging: "show me" or "no thanks".`,
  },
  {
    name: "Follow-Up 2 - Last Note",
    kind: "followup2",
    subject: "last one from me, {business_name}",
    body: `{greeting}

Last note from me, I promise. I only build a handful of free mockups each month, so I'm closing this one out and giving the slot to the next business on my list.

If you want it first, reply "show me" today and it's yours.

Either way, good luck out there. With {reviews} reviews at {rating} stars, {business_name} has clearly earned it.

Erik`,
  },
];

for (const t of templates) {
  db.prepare("INSERT INTO email_templates (name, kind, subject, body) VALUES (?, ?, ?, ?)")
    .run(t.name, t.kind, t.subject, t.body);
}

console.log(`Seeded ${leads.length} demo leads and ${templates.length} email templates.`);
console.log(`Templates sign off as Erik. Review them in Outreach > Manage Templates before sending anything.`);
