import SwiftUI

struct MainTabView: View {
    @EnvironmentObject var authManager: AuthManager

    var body: some View {
        TabView {
            JobsListView()
                .tabItem {
                    Label("Jobs", systemImage: "hammer.fill")
                }

            TimeClockView()
                .tabItem {
                    Label("Time Clock", systemImage: "clock.fill")
                }

            CalendarView()
                .tabItem {
                    Label("Schedule", systemImage: "calendar")
                }

            ProfileView()
                .tabItem {
                    Label("Profile", systemImage: "person.fill")
                }
        }
        .accentColor(Color(hex: "667eea"))
    }
}
