// Google Maps lead scraping via the Places API (Text Search + Details).
// With no GOOGLE_MAPS_API_KEY set it returns generated mock results so the
// import flow is fully testable offline.
import { cityCoords } from "./db.js";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

export const mapsConfigured = !!API_KEY;

// Places API (New): one searchText request returns everything, including
// coordinates — no per-place Details calls. (Legacy Places API is not
// enableable on new Google Cloud projects.)
export async function scrapeLeads(niche, city) {
  if (!mapsConfigured) return { mock: true, results: mockResults(niche, city) };

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location",
    },
    body: JSON.stringify({ textQuery: `${niche} in ${city}`, pageSize: 20 }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Places API error: ${data.error?.status || res.status} ${data.error?.message || ""}`);

  const results = (data.places || []).map((p) => ({
    business_name: p.displayName?.text || "",
    phone: p.nationalPhoneNumber || "",
    location: p.formattedAddress || city,
    industry: niche,
    website_url: p.websiteUri || "",
    website_status: p.websiteUri ? "Has Website" : "No Website",
    star_rating: p.rating || 0,
    review_count: p.userRatingCount || 0,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  }));
  // The pitch targets businesses without websites; surface those first.
  results.sort((a, b) => (a.website_url ? 1 : 0) - (b.website_url ? 1 : 0));
  return { mock: false, results };
}

function mockResults(niche, city) {
  const names = [
    "Sunrise", "Coastal", "Premier", "Golden Palm", "Family First",
    "Blue Heron", "All-Pro", "Hometown", "Five Star", "Gulfside",
  ];
  return names.map((n, i) => ({
    ...(cityCoords(city, i + 100) || { lat: null, lng: null }),
    business_name: `${n} ${titleCase(niche)}`,
    phone: `(305) 555-0${100 + i}`,
    location: `${city}`,
    industry: niche,
    website_url: i % 4 === 3 ? `https://www.${n.toLowerCase().replace(/\s/g, "")}${niche.toLowerCase().replace(/\s/g, "")}.com` : "",
    website_status: i % 4 === 3 ? "Has Website" : "No Website",
    star_rating: Math.round((3.4 + (i % 5) * 0.4) * 10) / 10,
    review_count: 8 + i * 17,
  }));
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1));
}
