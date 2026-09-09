import { Footer, Nav } from './components/Chrome';
import { Home } from './pages/Home';
import { Docs } from './pages/Docs';
import { useRoute } from './router';

export function App() {
  const route = useRoute();
  return (
    <>
      <a className="skip" href="#main">
        跳到主内容
      </a>
      <Nav route={route} />
      <main id="main">{route === 'docs' ? <Docs /> : <Home />}</main>
      <Footer />
    </>
  );
}
