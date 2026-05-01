import SwiftUI

struct CalendarView: View {
    @State private var jobs: [Job] = []
    @State private var selectedDate = Date()
    @State private var isLoading = false

    var scheduledJobs: [Job] {
        jobs.filter { job in
            guard let dateString = job.scheduledDate,
                  !dateString.isEmpty,
                  let jobDate = dateFromString(dateString) else {
                return false
            }
            return Calendar.current.isDate(jobDate, inSameDayAs: selectedDate)
        }
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Date Picker
                DatePicker("", selection: $selectedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .background(Color(.systemGray6))

                Divider()

                // Jobs for Selected Date
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if scheduledJobs.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "calendar.badge.clock")
                            .font(.system(size: 60))
                            .foregroundColor(.gray)
                        Text("No jobs scheduled")
                            .font(.headline)
                            .foregroundColor(.secondary)
                        Text(selectedDate, style: .date)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(scheduledJobs) { job in
                        NavigationLink(destination: JobDetailView(job: job)) {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(job.title)
                                        .font(.headline)

                                    Spacer()

                                    if let time = job.scheduledTime {
                                        Text(time)
                                            .font(.subheadline)
                                            .foregroundColor(Color(hex: "667eea"))
                                            .fontWeight(.semibold)
                                    }
                                }

                                if let clientName = job.clientName {
                                    Text(clientName)
                                        .font(.subheadline)
                                        .foregroundColor(.secondary)
                                }

                                if let address = job.address {
                                    HStack {
                                        Image(systemName: "mappin.circle.fill")
                                            .font(.caption)
                                            .foregroundColor(.gray)
                                        Text(address)
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                }

                                HStack {
                                    Text(job.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(.caption)
                                        .fontWeight(.semibold)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(Color(job.statusColor).opacity(0.2))
                                        .foregroundColor(Color(job.statusColor))
                                        .cornerRadius(8)

                                    Spacer()

                                    if let total = job.total {
                                        Text(job.formattedTotal)
                                            .font(.subheadline)
                                            .fontWeight(.bold)
                                            .foregroundColor(Color(hex: "667eea"))
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .listStyle(PlainListStyle())
                }
            }
            .navigationTitle("Schedule")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                await loadJobs()
            }
        }
        .task {
            await loadJobs()
        }
    }

    func loadJobs() async {
        isLoading = true

        do {
            jobs = try await APIService.shared.fetchJobs()
            isLoading = false
        } catch {
            print("Failed to load jobs: \(error)")
            isLoading = false
        }
    }

    func dateFromString(_ dateString: String) -> Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: dateString)
    }
}
