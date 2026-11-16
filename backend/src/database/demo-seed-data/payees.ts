export interface DemoPayee {
  name: string;
  categoryPath: string; // "Parent > Subcategory" or just "Category"
  /**
   * The payee's real site, absolute, so the seeder can resolve a brand icon
   * from it exactly as a user-entered website would. Omitted for the payees
   * that stand in for a person or a private business: a made-up domain would
   * resolve to no favicon and a link to nowhere.
   */
  website?: string;
  /** Free text, one field, as the column stores it. */
  address?: string;
  /**
   * E.164, already in the form `PayeesService` would normalize a typed number
   * to, so a demo row and a row the user saves over it hold one format and a
   * `tel:` link dials the same digits either way.
   *
   * Invented, but not from the fictional `555` range: the `max` metadata the
   * normalizer uses correctly rejects it, and a demo row the payee form then
   * refuses to save is worse than no number. They are instead a synthetic
   * block -- exchange `260`, sequential last four -- in the payee's own area
   * code, or `833` where a national brand would publish a toll-free line.
   */
  phone?: string;
}

/**
 * Street addresses and phone numbers here are invented; no demo row carries a
 * business's real line. The websites are real, and are what the payee brand
 * icons are resolved from.
 */
export const demoPayees: DemoPayee[] = [
  // Income
  {
    name: "Maple Leaf Technologies",
    categoryPath: "Salary",
    address: "2400 Yonge Street, Suite 1100, Toronto, ON M4P 2H4",
    phone: "+14162600101",
  },
  { name: "Freelance Client - WebDev", categoryPath: "Freelance" },

  // Housing
  {
    name: "Scotiabank Mortgage",
    categoryPath: "Housing > Rent/Mortgage",
    website: "https://www.scotiabank.com",
    address: "44 King Street West, Toronto, ON M5H 1H1",
    phone: "+18332600102",
  },
  {
    name: "Hydro One",
    categoryPath: "Bills & Utilities > Electricity",
    website: "https://www.hydroone.com",
    address: "483 Bay Street, Toronto, ON M5G 2P5",
    phone: "+18332600103",
  },
  {
    name: "Enbridge Gas",
    categoryPath: "Bills & Utilities > Insurance",
    website: "https://www.enbridgegas.com",
    address: "500 Consumers Road, North York, ON M2J 1P8",
    phone: "+18332600104",
  },
  {
    name: "Toronto Water",
    categoryPath: "Bills & Utilities > Water",
    website: "https://www.toronto.ca",
    address: "100 Queen Street West, Toronto, ON M5H 2N2",
    phone: "+14162600105",
  },

  // Transport
  {
    name: "Shell",
    categoryPath: "Transportation > Fuel",
    website: "https://www.shell.ca",
    address: "1810 Danforth Avenue, Toronto, ON M4C 1J4",
    phone: "+14162600106",
  },
  {
    name: "Esso",
    categoryPath: "Transportation > Fuel",
    website: "https://www.esso.ca",
    address: "2350 Lake Shore Boulevard West, Toronto, ON M8V 1B5",
    phone: "+14162600107",
  },
  {
    name: "TTC",
    categoryPath: "Transportation > Public Transit",
    website: "https://www.ttc.ca",
    address: "1900 Yonge Street, Toronto, ON M4S 1Z2",
    phone: "+14162600108",
  },
  {
    name: "Canadian Tire Auto",
    categoryPath: "Transportation > Maintenance",
    website: "https://www.canadiantire.ca",
    address: "839 Yonge Street, Toronto, ON M4W 2H2",
    phone: "+14162600109",
  },
  {
    name: "Aviva Insurance",
    categoryPath: "Transportation > Car Insurance",
    website: "https://www.avivacanada.com",
    address: "10 Aviva Way, Markham, ON L6G 0G1",
    phone: "+18332600110",
  },

  // Food & Dining
  {
    name: "Loblaws",
    categoryPath: "Food > Groceries",
    website: "https://www.loblaws.ca",
    address: "60 Carlton Street, Toronto, ON M5B 1J2",
    phone: "+14162600111",
  },
  {
    name: "No Frills",
    categoryPath: "Food > Groceries",
    website: "https://www.nofrills.ca",
    address: "449 Dundas Street East, Toronto, ON M5A 2B1",
    phone: "+14162600112",
  },
  {
    name: "Metro",
    categoryPath: "Food > Groceries",
    website: "https://www.metro.ca",
    address: "444 Yonge Street, Toronto, ON M4Y 1S9",
    phone: "+14162600113",
  },
  {
    name: "Costco",
    categoryPath: "Food > Groceries",
    website: "https://www.costco.ca",
    address: "50 Thermos Road, Scarborough, ON M1L 4W2",
    phone: "+14162600114",
  },
  {
    name: "Tim Hortons",
    categoryPath: "Food > Coffee Shops",
    website: "https://www.timhortons.ca",
    address: "318 Bay Street, Toronto, ON M5H 2R2",
    phone: "+14162600115",
  },
  {
    name: "Starbucks",
    categoryPath: "Food > Coffee Shops",
    website: "https://www.starbucks.ca",
    address: "225 Queen Street West, Toronto, ON M5V 1Z4",
    phone: "+14162600116",
  },
  {
    name: "Swiss Chalet",
    categoryPath: "Food > Restaurants",
    website: "https://www.swisschalet.com",
    address: "234 Bloor Street West, Toronto, ON M5S 1T8",
    phone: "+14162600117",
  },
  {
    name: "Uber Eats",
    categoryPath: "Food > Restaurants",
    website: "https://www.ubereats.com",
    address: "121 Bloor Street East, Toronto, ON M4W 3M5",
    phone: "+18332600118",
  },
  {
    name: "The Keg Steakhouse",
    categoryPath: "Food > Restaurants",
    website: "https://www.kegsteakhouse.com",
    address: "515 Jarvis Street, Toronto, ON M4Y 2H6",
    phone: "+14162600119",
  },

  // Shopping
  {
    name: "Amazon.ca",
    categoryPath: "Shopping > Electronics",
    website: "https://www.amazon.ca",
    address: "120 Bremner Boulevard, Toronto, ON M5J 0A8",
    phone: "+18332600120",
  },
  {
    name: "Best Buy",
    categoryPath: "Shopping > Electronics",
    website: "https://www.bestbuy.ca",
    address: "65 Dundas Street West, Toronto, ON M5G 2C3",
    phone: "+18332600121",
  },
  {
    name: "IKEA",
    categoryPath: "Shopping > Home Goods",
    website: "https://www.ikea.com",
    address: "15 Provost Drive, North York, ON M2K 2X9",
    phone: "+18332600122",
  },
  {
    name: "Winners",
    categoryPath: "Shopping > Clothing",
    website: "https://www.winners.ca",
    address: "444 Yonge Street, Toronto, ON M5B 2H4",
    phone: "+14162600123",
  },

  // Bills & Subscriptions
  {
    name: "Bell Canada",
    categoryPath: "Bills & Utilities > Phone",
    website: "https://www.bell.ca",
    address: "483 Bay Street, Toronto, ON M5G 2C9",
    phone: "+18332600124",
  },
  {
    name: "Rogers Internet",
    categoryPath: "Bills & Utilities > Internet",
    website: "https://www.rogers.com",
    address: "333 Bloor Street East, Toronto, ON M4W 1G9",
    phone: "+18332600125",
  },
  {
    name: "Netflix",
    categoryPath: "Entertainment > Streaming Services",
    website: "https://www.netflix.com",
    address: "100 Winchester Circle, Los Gatos, CA 95032",
    phone: "+18332600126",
  },
  {
    name: "Spotify",
    categoryPath: "Entertainment > Streaming Services",
    website: "https://www.spotify.com",
    address: "150 Greenwich Street, New York, NY 10007",
    phone: "+18332600127",
  },
  {
    name: "Disney+",
    categoryPath: "Entertainment > Streaming Services",
    website: "https://www.disneyplus.com",
    address: "500 South Buena Vista Street, Burbank, CA 91521",
    phone: "+18332600128",
  },

  // Health
  {
    name: "Shoppers Drug Mart",
    categoryPath: "Health > Pharmacy",
    website: "https://www.shoppersdrugmart.ca",
    address: "465 Yonge Street, Toronto, ON M4Y 1X4",
    phone: "+14162600129",
  },
  {
    name: "GoodLife Fitness",
    categoryPath: "Health > Gym",
    website: "https://www.goodlifefitness.com",
    address: "137 Yonge Street, Toronto, ON M5C 1W6",
    phone: "+18332600130",
  },
  {
    name: "Dr. Smith",
    categoryPath: "Health > Doctor Visits",
    address: "720 Spadina Avenue, Suite 305, Toronto, ON M5S 2T9",
    phone: "+14162600131",
  },

  // Other
  {
    name: "Cineplex",
    categoryPath: "Entertainment > Movies",
    website: "https://www.cineplex.com",
    address: "259 Richmond Street West, Toronto, ON M5V 3M6",
    phone: "+14162600132",
  },
  {
    name: "Air Canada",
    categoryPath: "Travel",
    website: "https://www.aircanada.com",
    address: "6001 Boulevard Robert-Bourassa, Dorval, QC H4S 1Z4",
    phone: "+18332600133",
  },
  {
    name: "Airbnb",
    categoryPath: "Travel",
    website: "https://www.airbnb.ca",
    address: "888 Brannan Street, San Francisco, CA 94103",
    phone: "+18332600134",
  },
];
